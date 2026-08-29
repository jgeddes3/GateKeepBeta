// The one shadowed overlay in the primitive set (DESIGN.md caps mobile glass
// / shadow use); wraps RN's Modal as a bottom sheet. The outer Pressable
// (the scrim) closes on press; the inner Pressable swallows the press so
// tapping the sheet's own content does not also close it.
import { Modal, Pressable } from "react-native";
import type { ReactNode } from "react";
import { tokens } from "../theme/tokens";
import { useTokens } from "../theme/ThemeProvider";

export function Sheet({
  visible,
  onClose,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const t = useTokens();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" }}
      >
        <Pressable
          onPress={() => {}}
          style={{
            backgroundColor: t.surface,
            borderTopLeftRadius: tokens.radius.card,
            borderTopRightRadius: tokens.radius.card,
            padding: tokens.space.xl,
            borderColor: t.border,
            borderWidth: 1,
            shadowColor: "#000",
            shadowOpacity: 0.3,
            shadowRadius: 16,
            shadowOffset: { width: 0, height: -4 },
            elevation: 12,
          }}
        >
          {children}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
