import type { ReactNode, SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { children?: ReactNode }

function Icon({ children, className = 'h-4 w-4', ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...props}
    >
      {children}
    </svg>
  )
}

export const LogoIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 8v8M8 5v14M12 3v18M16 6v12M20 9v6" />
  </Icon>
)

export const UploadIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 16V4M7.5 8.5 12 4l4.5 4.5" />
    <path d="M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" />
  </Icon>
)

export const PlayIcon = (props: IconProps) => (
  <Icon {...props}><path fill="currentColor" stroke="none" d="m9 7 8 5-8 5V7Z" /></Icon>
)

export const PauseIcon = (props: IconProps) => (
  <Icon {...props}><path d="M9 7v10M15 7v10" strokeWidth="2.4" /></Icon>
)

export const BackIcon = (props: IconProps) => (
  <Icon {...props}><path d="m11 7-5 5 5 5M18 7v10" /></Icon>
)

export const ForwardIcon = (props: IconProps) => (
  <Icon {...props}><path d="m13 7 5 5-5 5M6 7v10" /></Icon>
)

export const UndoIcon = (props: IconProps) => (
  <Icon {...props}><path d="m9 8-4 4 4 4" /><path d="M5 12h8a6 6 0 0 1 6 6" /></Icon>
)

export const SparklesIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m12 3 .8 2.2L15 6l-2.2.8L12 9l-.8-2.2L9 6l2.2-.8L12 3Z" />
    <path d="m6.5 10 1.3 3.2L11 14.5l-3.2 1.3L6.5 19l-1.3-3.2L2 14.5l3.2-1.3L6.5 10Z" />
    <path d="m17.5 11 1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1 1-2.5Z" />
  </Icon>
)

export const CleanIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m4 19 8-8" /><path d="m10 5 9 9" /><path d="m13 16 3 3 4-4-3-3" />
    <path d="m6 17 2 2" />
  </Icon>
)

export const FillerIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 5.5h16v11H9l-5 3v-14Z" />
    <path d="M8 9h8M8 12.5h5" />
  </Icon>
)

export const GapIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 5v14M20 5v14" />
    <path d="M7 12h10M9.5 9.5 7 12l2.5 2.5M14.5 9.5 17 12l-2.5 2.5" />
  </Icon>
)

export const RetakeIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m8 5-4 4 4 4" />
    <path d="M4 9h10a5 5 0 0 1 5 5v4" />
    <path d="M11 17h8" />
  </Icon>
)

export const DownloadIcon = (props: IconProps) => (
  <Icon {...props}><path d="M12 4v11M8 11l4 4 4-4" /><path d="M5 20h14" /></Icon>
)

export const CloseIcon = (props: IconProps) => (
  <Icon {...props}><path d="m7 7 10 10M17 7 7 17" /></Icon>
)

export const FolderIcon = (props: IconProps) => (
  <Icon {...props}><path d="M3.5 7.5h6l2-2h3l2 2h4v11h-17v-11Z" /></Icon>
)

export const AudioIcon = (props: IconProps) => (
  <Icon {...props}><path d="M9 18V6l9-2v12" /><circle cx="6" cy="18" r="3" /><circle cx="15" cy="16" r="3" /></Icon>
)

export const RevertIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 5v5h5" />
    <path d="M4.5 10a7.5 7.5 0 1 1 1.2 6" />
  </Icon>
)

export const LevelsIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M6 20V10M12 20V4M18 20v-7" />
    <path d="M3.5 13h5M9.5 8h5M15.5 16h5" />
  </Icon>
)

export const NoiseIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M3 12h2l1.5-5 2 10 2-13 2 16 2-11 1.5 3H21" />
  </Icon>
)

export const CheckIcon = (props: IconProps) => (
  <Icon {...props}><path d="m5 12 4 4L19 6" /></Icon>
)

export const EditIcon = (props: IconProps) => (
  <Icon {...props}><path d="m4 20 4.5-1 10-10-3.5-3.5-10 10L4 20Z" /><path d="m13.5 7 3.5 3.5" /></Icon>
)

export const ScissorsIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="6" cy="7" r="2.5" /><circle cx="6" cy="17" r="2.5" />
    <path d="m8 8.5 11 7.5M8 15.5 19 8" />
  </Icon>
)

export const MoreIcon = (props: IconProps) => (
  <Icon {...props}><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" /></Icon>
)

export const MoonIcon = (props: IconProps) => (
  <Icon {...props}><path d="M20.5 15.2A8.4 8.4 0 0 1 8.8 3.5 8.5 8.5 0 1 0 20.5 15.2Z" /></Icon>
)

export const SunIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="3.5" />
    <path d="M12 2.5v2M12 19.5v2M21.5 12h-2M4.5 12h-2M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4M18.7 18.7l-1.4-1.4M6.7 6.7 5.3 5.3" />
  </Icon>
)
