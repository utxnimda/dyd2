import type { InjectionKey } from "vue";

export type TreasuryAvatarBridge = {
  /** id 在金库列表中时：在当前页弹出该成员金库详情与流水（不切换页签） */
  openIfMember: (memberId: string | number | null | undefined) => void;
};

export const FMZ_TREASURY_AVATAR_KEY: InjectionKey<TreasuryAvatarBridge> = Symbol(
  "fmzTreasuryAvatar",
);
