/**
 * skillSource —— 由本地 skill 的 registry origin(+ server 归属信号)派生「来源」分类。
 *
 * 用户视角只关心技能是否为应用项目自带：
 * 明确 origin=installed 的技能归内部，其余扫描到的技能全部归外部。
 */

export type SkillSource = 'internal' | 'external';

/**
 * 收敛成两档来源,供首页来源徽标使用。
 * @param origin           registry 记录的本地来源(缺失 = 历史遗留 / 无)
 * @param hasRegistryEntry 该 skill 是否有 registry 记录(= 有过市场交互:安装或发布)
 * @param isMine           server 权威归属:true=我的 / false=他人 / null|undefined=未知
 */
export function deriveSkillSource(
  origin: 'installed' | 'published' | 'learned' | 'imported' | null | undefined,
  hasRegistryEntry: boolean,
  isMine: boolean | null | undefined,
): SkillSource {
  void hasRegistryEntry;
  void isMine;
  // 只有明确标记为项目自带的来源才进入内部技能,其余本地扫描结果都归外部。
  if (origin === 'installed') return 'internal';
  return 'external';
}
