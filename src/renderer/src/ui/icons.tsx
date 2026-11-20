const S = ({ children, size = 16 }: { children: React.ReactNode; size?: number }): React.JSX.Element => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
)
export const IconPlay = (): React.JSX.Element => <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4.5 2.6v10.8a.6.6 0 0 0 .92.5l8.4-5.4a.6.6 0 0 0 0-1L5.42 2.1a.6.6 0 0 0-.92.5Z" /></svg>
export const IconPause = (): React.JSX.Element => <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="3.5" y="2.5" width="3.2" height="11" rx="1" /><rect x="9.3" y="2.5" width="3.2" height="11" rx="1" /></svg>
export const IconLoop = (): React.JSX.Element => <S><path d="M3 8a4.5 4.5 0 0 1 4.5-4.5H12" /><path d="m10 1.5 2 2-2 2" /><path d="M13 8a4.5 4.5 0 0 1-4.5 4.5H4" /><path d="m6 14.5-2-2 2-2" /></S>
export const IconChat = (): React.JSX.Element => <S><path d="M2.5 4.5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H7l-3 2.5v-2.5a2 2 0 0 1-1.5-2Z" /></S>
export const IconGear = (): React.JSX.Element => <S><circle cx="8" cy="8" r="2.1" /><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.15 1.15M11.25 11.25l1.15 1.15M3.6 12.4l1.15-1.15M11.25 4.75l1.15-1.15" /></S>
export const IconExport = (): React.JSX.Element => <S><path d="M8 10V2.5" /><path d="m5 5 3-3 3 3" /><path d="M2.5 10v2a1.5 1.5 0 0 0 1.5 1.5h8a1.5 1.5 0 0 0 1.5-1.5v-2" /></S>
export const IconEye = (): React.JSX.Element => <S><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8Z" /><circle cx="8" cy="8" r="1.9" /></S>
export const IconCheck = (): React.JSX.Element => <S size={11}><path d="m3 8.5 3.2 3L13 4.5" /></S>
export const IconAlert = (): React.JSX.Element => <S size={11}><path d="M8 3v6" /><path d="M8 12.2v.3" /></S>
export const IconSend = (): React.JSX.Element => <S size={14}><path d="M8 13V3" /><path d="m3.5 7.5 4.5-4.5 4.5 4.5" /></S>
export const IconStop = (): React.JSX.Element => <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true"><rect width="10" height="10" rx="2" /></svg>
export const IconChevron = (): React.JSX.Element => <S size={10}><path d="m4 6 4 4 4-4" /></S>
export const IconUndo = (): React.JSX.Element => <S><path d="M3 6.5h6.5a3.5 3.5 0 0 1 0 7H6" /><path d="m5.5 4-2.5 2.5L5.5 9" /></S>
export const IconRedo = (): React.JSX.Element => <S><path d="M13 6.5H6.5a3.5 3.5 0 0 0 0 7H10" /><path d="m10.5 4 2.5 2.5L10.5 9" /></S>
