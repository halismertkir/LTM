import type { AudioSource, DeviceKind } from "@ltm/protocol";
import type { ReactNode, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 18, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconTimeline = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4Z" />
    <path d="M5 17a3 3 0 0 1 3-3h11M9 8h6" />
  </Svg>
);
export const IconMemory = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3l2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 15.4 7.2 18l.9-5.4-3.9-3.8 5.4-.8L12 3Z" />
  </Svg>
);
export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.2-4.2" />
  </Svg>
);
export const IconDevices = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="5" width="13" height="10" rx="1.5" />
    <path d="M7 19h5" />
    <rect x="16" y="9" width="5" height="11" rx="1.2" />
  </Svg>
);
export const IconSettings = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
    <circle cx="16" cy="7" r="2" />
    <circle cx="10" cy="17" r="2" />
  </Svg>
);
export const IconPause = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 6v12M15 6v12" strokeWidth={2.4} />
  </Svg>
);
export const IconPlay = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 5.5v13l10.5-6.5L8 5.5Z" fill="currentColor" />
  </Svg>
);
export const IconLock = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </Svg>
);
export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Svg>
);
export const IconX = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);
export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);
export const IconEdit = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z" />
    <path d="m13.5 6.5 4 4" />
  </Svg>
);
export const IconTrash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
  </Svg>
);
export const IconCopy = (p: IconProps) => (
  <Svg {...p}>
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
  </Svg>
);
export const IconRefresh = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4" />
  </Svg>
);
export const IconSun = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
  </Svg>
);
export const IconMoon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
  </Svg>
);
export const IconAuto = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor" />
  </Svg>
);
export const IconGlobe = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17M12 3.5c2.5 2.6 3.5 5.5 3.5 8.5s-1 5.9-3.5 8.5c-2.5-2.6-3.5-5.5-3.5-8.5s1-5.9 3.5-8.5Z" />
  </Svg>
);
export const IconLogout = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16l-4-4 4-4M6 12h10" />
  </Svg>
);
export const IconArrowLeft = (p: IconProps) => (
  <Svg {...p}>
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </Svg>
);
export const IconUsers = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9" cy="8.5" r="3" />
    <path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 5.8a3 3 0 0 1 0 5.4M17.5 14.2A5.5 5.5 0 0 1 20.5 19" />
  </Svg>
);
export const IconTask = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4" y="4" width="16" height="16" rx="3" />
    <path d="m8.5 12 2.5 2.5 4.5-5" />
  </Svg>
);
export const IconShield = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3 5 6v5c0 4.5 3 8.3 7 10 4-1.7 7-5.5 7-10V6l-7-3Z" />
  </Svg>
);
export const IconCloud = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 18a4.5 4.5 0 0 1-.5-9A6 6 0 0 1 18 9.5 4.3 4.3 0 0 1 17.5 18H7Z" />
  </Svg>
);
export const IconHome = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 11 12 4l8 7v9H4v-9Z" />
    <path d="M10 20v-5h4v5" />
  </Svg>
);
export const IconDownload = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
  </Svg>
);
export const IconChat = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 5h14v10H10l-5 4V5Z" />
  </Svg>
);
export const IconSparkle = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.5 6.5l2 2M15.5 15.5l2 2M6.5 17.5l2-2M15.5 8.5l2-2" />
  </Svg>
);

// --- device kinds and audio sources

const IconPuzzle = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 4h3v2a1.5 1.5 0 0 0 3 0V4h3a1 1 0 0 1 1 1v4h-2a1.5 1.5 0 0 0 0 3h2v6a1 1 0 0 1-1 1h-5v-2a1.5 1.5 0 0 0-3 0v2H5a1 1 0 0 1-1-1v-5h2a1.5 1.5 0 0 0 0-3H4V5a1 1 0 0 1 1-1h4Z" />
  </Svg>
);
const IconPhone = (p: IconProps) => (
  <Svg {...p}>
    <rect x="7" y="3" width="10" height="18" rx="2.5" />
    <path d="M11 18h2" />
  </Svg>
);
const IconWatch = (p: IconProps) => (
  <Svg {...p}>
    <rect x="6.5" y="6.5" width="11" height="11" rx="3" />
    <path d="M9 6.5 9.5 3h5l.5 3.5M9 17.5l.5 3.5h5l.5-3.5M12 10v2.2l1.4 1" />
  </Svg>
);
const IconBrowser = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4.5" width="18" height="15" rx="2" />
    <path d="M3 9h18M6 6.8h.01M8.5 6.8h.01" />
  </Svg>
);
const IconDesktop = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="12" rx="1.5" />
    <path d="M9 20h6M12 16v4" />
  </Svg>
);
const IconDot = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="5" />
  </Svg>
);

export function DeviceIcon({ kind, ...p }: IconProps & { kind: DeviceKind | undefined }) {
  switch (kind) {
    case "browser_extension":
      return <IconPuzzle {...p} />;
    case "iphone":
      return <IconPhone {...p} />;
    case "apple_watch":
      return <IconWatch {...p} />;
    case "web":
      return <IconBrowser {...p} />;
    case "desktop":
      return <IconDesktop {...p} />;
    default:
      return <IconDot {...p} />;
  }
}

const IconMic = (p: IconProps) => (
  <Svg {...p}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
  </Svg>
);
const IconTab = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 19V8a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v8H3Z" />
  </Svg>
);
const IconSpeaker = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4v-5ZM16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11" />
  </Svg>
);
const IconRoom = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 12h.01M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8" />
  </Svg>
);

export function SourceIcon({ source, ...p }: IconProps & { source: AudioSource }) {
  switch (source) {
    case "tab":
      return <IconTab {...p} />;
    case "mic":
      return <IconMic {...p} />;
    case "system":
      return <IconSpeaker {...p} />;
    case "ambient":
      return <IconRoom {...p} />;
  }
}
