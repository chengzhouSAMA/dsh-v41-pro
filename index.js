/**
 * V4.1 Pro 工程增强 —— 十七个模块组合入口。
 *
 * 十三个子插件各占一行是推荐装法（可单独开关、单独调参）：
 *
 *   v41pro-escalator     卡住探测 + 中途升级到 v4-pro
 *   v41pro-ledger        状态外置台账（改了什么 / 失败过什么）
 *   v41pro-verifier      验证闸门 + pro_verify 工具
 *   v41pro-tempo         步数 / 时间 / 工具失败次数三份预算
 *   v41pro-forker        决策点分叉（pro_fork）
 *   v41pro-critic        独立视角复审（pro_critique）
 *   v41pro-cartographer  压缩后的上下文地图与验证证据
 *   v41pro-language      按需语言优化 Skill
 *   v41pro-fiction       按需小说创作与文学审校 Skill
 *   v41pro-novel         长篇小说工作区
 *   v41pro-thinking      发散 / 聚焦 / 透彻（仅 max）/ 自动思考模式
 *   v41pro-ethical-conduct 常驻完整行为准则（独立于思考模式）
 *   v41pro-omni          全模态媒体工具（内置自 ZTR66/dsh-omni）
 *   v41pro-acceptance    可执行验收标准 + 收尾闸门
 *   v41pro-calibration   预测校准账本（Brier / 耗时误差）
 *   v41pro-retro         复盘与规则库（按关键词回注）
 *   v41pro-shrink        代码精简审查（写完代码必须过）
 *
 * 也可以只占一行，用嵌套 config 一次配完：
 *
 *   - id: v41pro
 *     name: 'dsh-v41-pro'
 *     config:
 *       escalator: { mode: escalate }
 *       forker: { count: 3 }
 *
 * 缺服务时按插件各自降级：没有 subagents → forker/critic 休眠；没有 shell →
 * verifier 只剩闸门（工具不注册）；其余照常。
 */

import * as escalator from './src/escalator.js'
import * as ledger from './src/ledger.js'
import * as verifier from './src/verifier.js'
import * as tempo from './src/tempo.js'
import * as forker from './src/forker.js'
import * as critic from './src/critic.js'
import * as cartographer from './src/cartographer.js'
import * as language from './src/language.js'
import * as fiction from './src/fiction.js'
import * as novel from './src/novel.js'
import * as ethicalConduct from './src/ethical-conduct.js'
import * as thinking from './src/thinking.js'
import * as acceptance from './src/acceptance.js'
import * as calibration from './src/calibration.js'
import * as retro from './src/retro.js'
import * as shrink from './src/shrink.js'
import * as omni from './omni/index.js'

export const name = 'v41pro'

export const inject = ['tools']

export {
  escalator,
  ledger,
  verifier,
  tempo,
  forker,
  critic,
  cartographer,
  language,
  fiction,
  novel,
  thinking,
  ethicalConduct,
  acceptance,
  calibration,
  retro,
  shrink,
  omni,
}

/**
 * @param {any} ctx
 * @param {Record<string, object>} [config]
 */
export function apply(ctx, config = {}) {
  const cfg = config && typeof config === 'object' ? config : {}
  // DSH 仅扫描裸包名的 Client 入口；独立模块装法用该根行承载菜单。
  if (cfg.clientOnly === true) return
  const services = /** @type {any} */ (ctx)

  if (typeof ctx.inject === 'function') {
    ctx.inject(thinking.inject, child => thinking.apply(child, cfg.thinking ?? {}))
    ctx.inject(ethicalConduct.inject, child => ethicalConduct.apply(child))
    // 工程闭环四件套：各自的 inject 已声明 tools/commands(/shell)，这里统一等依赖就绪。
    ctx.inject(acceptance.inject, child => acceptance.apply(child, cfg.acceptance ?? {}))
    ctx.inject(calibration.inject, child => calibration.apply(child, cfg.calibration ?? {}))
    ctx.inject(retro.inject, child => retro.apply(child, cfg.retro ?? {}))
    ctx.inject(shrink.inject, child => shrink.apply(child, cfg.shrink ?? {}))
  }
  escalator.apply(ctx, cfg.escalator ?? {})
  ledger.apply(ctx, cfg.ledger ?? {})
  tempo.apply(ctx, cfg.tempo ?? {})
  cartographer.apply(ctx, cfg.cartographer ?? {})
  novel.apply(ctx, cfg.novel ?? {})
  if (services.skills) {
    language.apply(ctx, cfg.language ?? {})
    fiction.apply(ctx, cfg.fiction ?? {})
  }

  // 验证闸门需要沙箱执行器；没有它就不注册工具，避免「说有工具却跑不了」。
  if (services.shell) verifier.apply(ctx, cfg.verifier ?? {})

  // 分叉与复审需要子代理服务；没有 provider 时调用会失败，不如直接休眠。
  if (services.subagents) {
    forker.apply(ctx, cfg.forker ?? {})
    critic.apply(ctx, cfg.critic ?? {})
  }

  // 全模态媒体工具：只依赖 tools（其余能力在调用时探测），因此总是挂载。
  // 独立成行时由 patch 的 v41pro-omni 行负责，这里的聚合入口供单行装法使用。
  if (cfg.omni !== false) omni.apply(ctx, cfg.omni ?? {})
}
