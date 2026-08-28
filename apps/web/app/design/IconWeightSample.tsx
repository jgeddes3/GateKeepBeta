import {
  ArrowRight,
  CalendarCheck,
  CaretDown,
  CaretLeft,
  CaretRight,
  CaretUp,
  ChatCircle,
  Check,
  Circle,
  DotsThreeVertical,
  FunnelSimple,
  House,
  Info,
  List,
  MagnifyingGlass,
  MapPin,
  Monitor,
  Moon,
  MusicNotes,
  Pause,
  Play,
  Sun,
  UserCircle,
  Wallet,
  Warning,
  X,
} from "@phosphor-icons/react/ssr";

type PhosphorIcon = typeof House;

// Task 2, Step 3: the one place in the product that imports Phosphor icons
// at more than one weight. Every icon this app is likely to need (nav,
// actions, status, shell chrome) rendered at 16px and 20px in duotone AND
// regular, so the weight decision below is made by looking at the actual
// icon set rather than one or two examples. The decision and rationale are
// recorded in DESIGN.md > Icons; src/ui/icons.tsx pins the chosen weight
// in one place so no other file needs to (or can) import a weight
// directly.
const SAMPLE_ICONS: Array<{ name: string; icon: PhosphorIcon }> = [
  { name: "House", icon: House },
  { name: "MusicNotes", icon: MusicNotes },
  { name: "CalendarCheck", icon: CalendarCheck },
  { name: "Wallet", icon: Wallet },
  { name: "ChatCircle", icon: ChatCircle },
  { name: "UserCircle", icon: UserCircle },
  { name: "MagnifyingGlass", icon: MagnifyingGlass },
  { name: "FunnelSimple", icon: FunnelSimple },
  { name: "MapPin", icon: MapPin },
  { name: "ArrowRight", icon: ArrowRight },
  { name: "Info", icon: Info },
  { name: "Warning", icon: Warning },
  { name: "Play", icon: Play },
  { name: "Pause", icon: Pause },
  { name: "List", icon: List },
  { name: "Check", icon: Check },
  { name: "X", icon: X },
  { name: "Circle", icon: Circle },
  { name: "CaretDown", icon: CaretDown },
  { name: "CaretUp", icon: CaretUp },
  { name: "CaretLeft", icon: CaretLeft },
  { name: "CaretRight", icon: CaretRight },
  { name: "DotsThreeVertical", icon: DotsThreeVertical },
  { name: "Monitor", icon: Monitor },
  { name: "Moon", icon: Moon },
  { name: "Sun", icon: Sun },
];

function Cell({ icon: IconCmp, weight, size }: { icon: PhosphorIcon; weight: "duotone" | "regular"; size: number }) {
  return (
    <div className="flex items-center justify-center" style={{ color: "var(--gk-text)" }}>
      <IconCmp size={size} weight={weight} />
    </div>
  );
}

export function IconWeightSample() {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h2 className="font-syne text-xl font-semibold text-gk-text">Icon weight decision (Phosphor)</h2>
        <p className="mt-1 font-sora text-sm text-gk-muted">
          Every icon the app is likely to need, at 16px and 20px, in duotone and regular. See
          DESIGN.md &gt; Icons for the recorded decision.
        </p>
      </div>
      <div className="overflow-x-auto rounded-gk border border-gk-border bg-gk-surface">
        <table className="w-full min-w-[560px] border-collapse font-sora text-sm">
          <thead>
            <tr className="border-b border-gk-border text-left text-gk-muted">
              <th className="p-3 font-medium">Icon</th>
              <th className="p-3 text-center font-medium">Duotone 16px</th>
              <th className="p-3 text-center font-medium">Duotone 20px</th>
              <th className="p-3 text-center font-medium">Regular 16px</th>
              <th className="p-3 text-center font-medium">Regular 20px</th>
            </tr>
          </thead>
          <tbody>
            {SAMPLE_ICONS.map(({ name, icon }) => (
              <tr key={name} className="border-b border-gk-border last:border-b-0">
                <td className="p-3 text-gk-text">{name}</td>
                <td className="p-3">
                  <Cell icon={icon} weight="duotone" size={16} />
                </td>
                <td className="p-3">
                  <Cell icon={icon} weight="duotone" size={20} />
                </td>
                <td className="p-3">
                  <Cell icon={icon} weight="regular" size={16} />
                </td>
                <td className="p-3">
                  <Cell icon={icon} weight="regular" size={20} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
