import type { Metadata } from "next";
import { LegalPage, LegalSection } from "../../src/marketing/LegalPage";
import { Footer } from "../../src/shell/Footer";

export const metadata: Metadata = {
  title: "Terms of Service | GateKeep",
  robots: { index: false, follow: false },
};

// Placeholder legal text (spec section 6.9 / section 5 item 6): real,
// counsel-reviewed terms replace this before launch. See README's
// sub-project 9A launch checklist.
export default function TermsPage() {
  return (
    <>
      <LegalPage title="Terms of Service" bannerNoun="terms">
        <LegalSection heading="What GateKeep is">
          <p>
            GateKeep is a booking marketplace connecting musicians, event curators (venues,
            planners, and individual hosts), and fans in a single launch city. Musicians build
            portfolios and get booked for gigs. Curators post gigs or browse musicians directly.
            Fans discover shows and buy tickets where ticketing is available.
          </p>
        </LegalSection>
        <LegalSection heading="Your account">
          <p>
            You need an account to book, apply to, or post a gig. You&apos;re responsible for what
            happens under your account and for keeping your login secure. One account can hold
            more than one profile, for example a musician profile and a curator profile at the
            same time.
          </p>
        </LegalSection>
        <LegalSection heading="Bookings and cancellations">
          <p>
            A booking is an agreement between a musician and a curator, negotiated through offers
            and counters inside GateKeep. Once both sides accept, the booking is confirmed and a
            deposit is charged. Cancellation terms, grace periods, and no-show handling are
            enforced by the platform and will be spelled out here in full once counsel has
            reviewed this section.
          </p>
        </LegalSection>
        <LegalSection heading="Payments, fees, and payouts">
          <p>
            Payments and payouts are processed through our payment processor, Stripe. GateKeep
            charges a booking fee to curators and a commission to musicians on confirmed bookings;
            the current rates are stated on our home page. Musicians can request a payout of their
            available balance from their earnings page.
          </p>
        </LegalSection>
        <LegalSection heading="Content you provide">
          <p>
            Bios, photos, audio tracks, gig listings, and anything else you upload remain yours.
            You give GateKeep the license needed to host, display, and stream that content as part
            of running the marketplace, and you confirm you have the rights to upload it in the
            first place.
          </p>
        </LegalSection>
        <LegalSection heading="Conduct">
          <p>
            Don&apos;t use GateKeep to defraud another user, misrepresent who you are, or book a
            gig you don&apos;t intend to honor. Accounts that do can be suspended or removed.
          </p>
        </LegalSection>
        <LegalSection heading="Disclaimers and liability">
          <p>
            GateKeep provides the marketplace; it does not perform at, host, or produce the gigs
            booked through it. This section will carry the standard warranty disclaimers and
            liability limits once counsel finalizes them.
          </p>
        </LegalSection>
        <LegalSection heading="Governing law">
          <p>
            The governing jurisdiction and dispute process for these terms haven&apos;t been
            decided yet and will be added here before launch.
          </p>
        </LegalSection>
        <LegalSection heading="Changes to these terms">
          <p>
            We&apos;ll post an update here and change the date at the top when these terms change.
            Continuing to use GateKeep after a change means you accept the new terms.
          </p>
        </LegalSection>
        <LegalSection heading="Contact">
          <p>Reach us at the address in the footer below.</p>
        </LegalSection>
      </LegalPage>
      <Footer />
    </>
  );
}
