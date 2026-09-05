import { describe, it, expect, vi } from "vitest";
import { callFn, signUpTestUser } from "./helpers";
import { adb, makeApprovedCuratorProfile } from "./discoverFixtures";
import { addMember } from "./payoutFixtures";
import { makeMessagingPair, sendAs, conversation, mirror, messages, notesOfKind } from "./messagingFixtures";
import { MESSAGE_RATE_MAX } from "@gatekeep/shared";
vi.setConfig({ testTimeout: 120_000 });

describe("sendMessage", () => {
  it("creates the conversation on first send, increments the other side's unread, and notifies once per bucket", async () => {
    const p = await makeMessagingPair("sm1");
    const first = await sendAs(p.musician.owner.user, p.musicianProfileId, p.curatorProfileId, "  hello there  ");
    expect(first.conversationId).toBe(p.pairId);

    const conv = await conversation(p.pairId);
    expect(conv).toMatchObject({
      musicianProfileId: p.musicianProfileId, curatorProfileId: p.curatorProfileId,
      blockedBy: [], openReports: 0,
    });
    expect(conv!.participants.sort()).toEqual([p.curatorProfileId, p.musicianProfileId].sort());
    expect(conv!.unread[p.curatorProfileId]).toBe(1);
    expect(conv!.unread[p.musicianProfileId] ?? 0).toBe(0);
    expect(conv!.lastMessage).toMatchObject({ text: "hello there", senderProfileId: p.musicianProfileId });
    expect(conv!.lastMessageAt).toBe(conv!.lastMessage!.at);

    const rows = await messages(p.pairId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      senderProfileId: p.musicianProfileId, senderUid: p.musician.owner.uid, text: "hello there",
    });

    // Both per-profile mirrors land in the SAME transaction as the top-level
    // doc (ruling 1): each side sees the other's name and type, its own
    // unread count, and its own block state.
    const musicianSide = await mirror(p.musicianProfileId, p.pairId);
    const curatorSide = await mirror(p.curatorProfileId, p.pairId);
    expect(musicianSide).toMatchObject({
      pairId: p.pairId, otherProfileId: p.curatorProfileId, otherProfileName: "The Green Room",
      otherProfileType: "curator", unread: 0, blockedByMe: false, openReports: 0,
    });
    expect(curatorSide).toMatchObject({
      pairId: p.pairId, otherProfileId: p.musicianProfileId, otherProfileName: "The Act",
      otherProfileType: "musician", unread: 1, blockedByMe: false, openReports: 0,
    });
    for (const side of [musicianSide, curatorSide]) {
      expect(side!.lastMessage).toEqual(conv!.lastMessage);
      expect(side!.lastMessageAt).toBe(conv!.lastMessageAt);
      // The mirror carries one number, never the whole per-profile map.
      expect(typeof side!.unread).toBe("number");
    }

    const notes = await notesOfKind(p.curator.owner.uid, "message");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ refId: p.pairId, refKind: "curator" });
    expect((notes[0] as { title: string }).title).toContain("messaged");
    expect((notes[0] as { body: string }).body).toBe("hello there");
    // The dedupe key is per conversation per 10-minute bucket, so the doc id
    // is not a random one: a second send in the bucket collides with it.
    expect(notes[0].id).toMatch(new RegExp(`^message:${p.pairId}:\\d+$`));
    // The sender's own members are never notified.
    expect(await notesOfKind(p.musician.owner.uid, "message")).toHaveLength(0);

    // A second send inside the same 10-minute bucket adds a message but no
    // second notification (create-if-absent on the bucketed dedupe key).
    await sendAs(p.musician.owner.user, p.musicianProfileId, p.curatorProfileId, "still there?");
    expect(await messages(p.pairId)).toHaveLength(2);
    expect((await conversation(p.pairId))!.unread[p.curatorProfileId]).toBe(2);
    expect((await mirror(p.curatorProfileId, p.pairId))!.unread).toBe(2);
    expect((await mirror(p.musicianProfileId, p.pairId))!.unread).toBe(0);
    expect(await notesOfKind(p.curator.owner.uid, "message")).toHaveLength(1);
  });

  it("lets the curator side start the same conversation, and notifies every member", async () => {
    const p = await makeMessagingPair("sm2");
    const extra = await addMember(p.curatorProfileId, "sm2x");
    const res = await sendAs(p.curator.owner.user, p.curatorProfileId, p.musicianProfileId, "we have a Friday");
    expect(res.conversationId).toBe(p.pairId);
    const conv = await conversation(p.pairId);
    expect(conv!.unread[p.musicianProfileId]).toBe(1);
    expect((await mirror(p.musicianProfileId, p.pairId))!.unread).toBe(1);
    expect((await mirror(p.curatorProfileId, p.pairId))!.unread).toBe(0);
    expect(await notesOfKind(p.musician.owner.uid, "message")).toHaveLength(1);
    // A second curator-side member sending later notifies the musician side,
    // and the extra member is a valid sender.
    await sendAs(extra.user, p.curatorProfileId, p.musicianProfileId, "from the other manager");
    expect((await messages(p.pairId))[1].senderUid).toBe(extra.uid);
  });

  it("refuses non-members, bad pairs, unapproved profiles, and bad text", async () => {
    const p = await makeMessagingPair("sm3");
    const stranger = await signUpTestUser(`sm3s-${Date.now()}@test.com`);
    await expect(sendAs(stranger.user, p.musicianProfileId, p.curatorProfileId, "hi"))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
    await expect(callFn("sendMessage",
      { fromProfileId: p.musicianProfileId, toProfileId: p.curatorProfileId, text: "hi" }))
      .rejects.toMatchObject({ code: "functions/unauthenticated" });

    // Two musicians, or two curators, are not a valid pair.
    const other = await makeMessagingPair("sm3b");
    await expect(sendAs(p.musician.owner.user, p.musicianProfileId, other.musicianProfileId, "hi"))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });

    for (const text of ["", "   ", "x".repeat(1001), 5, null]) {
      await expect(callFn("sendMessage",
        { fromProfileId: p.musicianProfileId, toProfileId: p.curatorProfileId, text }, p.musician.owner.user))
        .rejects.toMatchObject({
          code: "functions/invalid-argument", message: "Messages are 1 to 1000 characters.",
        });
    }

    await adb.doc(`profiles/${p.curatorProfileId}`).update({ status: "pending_review" });
    await expect(sendAs(p.musician.owner.user, p.musicianProfileId, p.curatorProfileId, "hi"))
      .rejects.toMatchObject({
        code: "functions/failed-precondition", message: "Only approved profiles can message.",
      });
    // Nothing was written on any refused path.
    expect(await conversation(p.pairId)).toBeUndefined();
    expect(await mirror(p.musicianProfileId, p.pairId)).toBeUndefined();
  });

  it("caps a sender profile at MESSAGE_RATE_MAX per window ACROSS conversations, and keeps the window bounded", async () => {
    const p = await makeMessagingPair("sm4");
    // A second curator profile the same musician can also message: the cap
    // must span both threads, so a spammer cannot buy a fresh 30 by opening
    // a new conversation with the next venue in town.
    const second = await makeApprovedCuratorProfile("sm4b", "venue");

    const half = MESSAGE_RATE_MAX / 2;
    for (let i = 0; i < half; i += 1) {
      await sendAs(p.musician.owner.user, p.musicianProfileId, p.curatorProfileId, `first thread ${i}`);
    }
    for (let i = 0; i < MESSAGE_RATE_MAX - half; i += 1) {
      await sendAs(p.musician.owner.user, p.musicianProfileId, second.profileId, `second thread ${i}`);
    }
    // The 31st send fails in EITHER conversation, including the one that has
    // only ever seen half the burst.
    for (const target of [p.curatorProfileId, second.profileId]) {
      await expect(sendAs(p.musician.owner.user, p.musicianProfileId, target, "one too many"))
        .rejects.toMatchObject({
          code: "functions/resource-exhausted",
          message: "You are sending too fast. Try again in a few minutes.",
        });
    }
    const window = (await adb.doc(`messageWindows/${p.musicianProfileId}`).get()).data() as { at: number[] };
    expect(window.at).toHaveLength(MESSAGE_RATE_MAX);
    // Nothing rate-related is left on the conversation doc.
    expect((await conversation(p.pairId)) as Record<string, unknown>).not.toHaveProperty("sendWindow");
    // The refused sends left the counters alone: half the burst in each thread.
    expect((await conversation(p.pairId))!.unread[p.curatorProfileId]).toBe(half);
    expect((await mirror(p.curatorProfileId, p.pairId))!.unread).toBe(half);
    // The other side is unaffected: the window is per SENDER profile.
    await expect(sendAs(p.curator.owner.user, p.curatorProfileId, p.musicianProfileId, "still fine"))
      .resolves.toMatchObject({ conversationId: p.pairId });

    // Ageing every timestamp out of the window reopens sending everywhere.
    await adb.doc(`messageWindows/${p.musicianProfileId}`).set({ at: [Date.now() - 11 * 60 * 1000] });
    await expect(sendAs(p.musician.owner.user, p.musicianProfileId, p.curatorProfileId, "back"))
      .resolves.toMatchObject({ conversationId: p.pairId });
  });
});

describe("setConversationBlock and markConversationRead", () => {
  it("blocks in both directions from either side's admin, and unblocks", async () => {
    const p = await makeMessagingPair("bk1");
    await sendAs(p.musician.owner.user, p.musicianProfileId, p.curatorProfileId, "hello");

    const plain = await addMember(p.curatorProfileId, "bk1p");
    await expect(callFn("setConversationBlock",
      { profileId: p.curatorProfileId, conversationId: p.pairId, blocked: true }, plain.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });

    const beforeBlock = await mirror(p.musicianProfileId, p.pairId);
    await callFn("setConversationBlock",
      { profileId: p.curatorProfileId, conversationId: p.pairId, blocked: true }, p.curator.owner.user);
    expect((await conversation(p.pairId))!.blockedBy).toEqual([p.curatorProfileId]);
    // Only the BLOCKER's mirror learns about it: blocks are silent, so the
    // blocked side's row is byte-for-byte what it was before.
    expect((await mirror(p.curatorProfileId, p.pairId))!.blockedByMe).toBe(true);
    expect(await mirror(p.musicianProfileId, p.pairId)).toEqual(beforeBlock);

    // Both directions refuse with the SAME neutral sentence.
    for (const [user, from, to] of [
      [p.musician.owner.user, p.musicianProfileId, p.curatorProfileId],
      [p.curator.owner.user, p.curatorProfileId, p.musicianProfileId],
    ] as const) {
      await expect(sendAs(user, from, to, "anyone there"))
        .rejects.toMatchObject({
          code: "functions/failed-precondition", message: "This conversation is closed.",
        });
    }
    // A profile cannot lift another profile's block.
    await callFn("setConversationBlock",
      { profileId: p.musicianProfileId, conversationId: p.pairId, blocked: false }, p.musician.owner.user);
    expect((await conversation(p.pairId))!.blockedBy).toEqual([p.curatorProfileId]);
    expect((await mirror(p.curatorProfileId, p.pairId))!.blockedByMe).toBe(true);

    await callFn("setConversationBlock",
      { profileId: p.curatorProfileId, conversationId: p.pairId, blocked: false }, p.curator.owner.user);
    expect((await conversation(p.pairId))!.blockedBy).toEqual([]);
    expect((await mirror(p.curatorProfileId, p.pairId))!.blockedByMe).toBe(false);
    await expect(sendAs(p.musician.owner.user, p.musicianProfileId, p.curatorProfileId, "back on"))
      .resolves.toMatchObject({ conversationId: p.pairId });
  });

  it("zeroes only the reader's own unread count, and refuses a non-member", async () => {
    const p = await makeMessagingPair("mr1");
    await sendAs(p.musician.owner.user, p.musicianProfileId, p.curatorProfileId, "one");
    await sendAs(p.curator.owner.user, p.curatorProfileId, p.musicianProfileId, "two");
    expect((await conversation(p.pairId))!.unread).toMatchObject({
      [p.curatorProfileId]: 1, [p.musicianProfileId]: 1,
    });
    await callFn("markConversationRead",
      { profileId: p.curatorProfileId, conversationId: p.pairId }, p.curator.owner.user);
    const conv = await conversation(p.pairId);
    expect(conv!.unread[p.curatorProfileId]).toBe(0);
    expect(conv!.unread[p.musicianProfileId]).toBe(1);
    // The reader's mirror follows the top-level doc; the other side's does not.
    expect((await mirror(p.curatorProfileId, p.pairId))!.unread).toBe(0);
    expect((await mirror(p.musicianProfileId, p.pairId))!.unread).toBe(1);
    // Idempotent.
    await callFn("markConversationRead",
      { profileId: p.curatorProfileId, conversationId: p.pairId }, p.curator.owner.user);
    expect((await conversation(p.pairId))!.unread[p.curatorProfileId]).toBe(0);
    expect((await mirror(p.curatorProfileId, p.pairId))!.unread).toBe(0);

    const stranger = await signUpTestUser(`mr1s-${Date.now()}@test.com`);
    await expect(callFn("markConversationRead",
      { profileId: p.curatorProfileId, conversationId: p.pairId }, stranger.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });
});
