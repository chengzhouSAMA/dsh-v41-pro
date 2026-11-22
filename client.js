/**
 * V4.1 Pro Client 端：思考模式控件 + 全模态（omni）设置页。
 *
 * 一个包只有一个浏览器入口（id 必须等于包名），所以两个界面合并在同一个
 * factory 里：思考模式挂 conversation.input.model.options，媒体设置页挂
 * settings.section 与 settings.section.icon。
 *
 * 挂载到 `conversation.input.model.options`：在模型 / 推理菜单的根页里追加
 * 一行「思考模式」，五个选项（自动 / 发散 / 聚焦 / 透彻 / 关闭）并显示各自对应的
 * 推理档位下限。
 *
 * 状态只读自 Host 投影 `v41proThinking`（wire view：
 * `{ mode:'auto'|'divergent'|'focused'|'thorough'|'off', phase:'divergent'|'focused'|'thorough', reopens:number }`），
 * 不维护本地乐观状态；切换通过 `/thinking <mode>` 命令提交，命令结果里的
 * error 优先经菜单所有者的 `reportFailure` 常驻 toast 展示，无该 prop 时用
 * 组件内 `role="alert"` 兜底。
 *
 * 本文件是安装式 bundle 的浏览器产物：通过 `window.__ModuleLoader__.load` 注册
 * 惰性 factory，id 必须等于包名 `dsh-v41-pro`；React 来自浏览器模块表，不 import
 * 任何 Harness Client 包。样式复用 `--dsw-*` 主题 token，随组件挂载/卸载。
 */

window.__ModuleLoader__.load({
  id: 'dsh-v41-pro',
  factory(require) {
    const React = require('react')
    const { useState, useEffect, useCallback } = React
    const h = React.createElement

    /** Client 词典命名空间（与 locale/thinking-ui-*.json 保持一致）。 */
    const NS = 'thinking-ui'

    /** 中文词典（默认语言）。 */
    const zh = {
      'mode.label': '思考模式',
      'mode.option.auto': '自动',
      'mode.option.divergent': '发散',
      'mode.option.focused': '聚焦',
      'mode.option.thorough': '透彻',
      'mode.option.off': '关闭',
      'mode.floor.auto': '自动在发散 / 聚焦间切换',
      'mode.floor.divergent': '最低 low',
      'mode.floor.focused': '最低 high',
      'mode.floor.thorough': '仅 max',
      'mode.floor.off': '关闭本模块（恢复之前档位）',
      'mode.phase.divergent': '发散',
      'mode.phase.focused': '聚焦',
      'mode.phase.thorough': '透彻',
      'mode.failed': '无法保存思考模式：{message}',
    }

    /** 英文词典。 */
    const en = {
      'mode.label': 'Thinking mode',
      'mode.option.auto': 'Auto',
      'mode.option.divergent': 'Divergent',
      'mode.option.focused': 'Focused',
      'mode.option.thorough': 'Thorough',
      'mode.option.off': 'Off',
      'mode.floor.auto': 'Switches between divergent and focused',
      'mode.floor.divergent': 'Min. low',
      'mode.floor.focused': 'Min. high',
      'mode.floor.thorough': 'Max only',
      'mode.floor.off': 'Module off (restores prior effort)',
      'mode.phase.divergent': 'divergent',
      'mode.phase.focused': 'focused',
      'mode.phase.thorough': 'thorough',
      'mode.failed': 'Could not save thinking mode: {message}',
    }

    /** 五个可选模式的固定顺序。 */
    const MODES = ['auto', 'divergent', 'focused', 'thorough', 'off']

    /** 菜单选项右侧的选中勾（不 import primitives，自绘一个无衬线描边勾）。 */
    const CHECK_SVG = h('svg', { viewBox: '0 0 16 16', 'aria-hidden': true },
      h('path', {
        d: 'M4.25 8.5l2.5 2.5 5-6',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }),
    )

    /** 组件局部样式，复用 `--dsw-*` token，随组件卸载被移除。 */
    const CSS = `
.v41pro-thinking-root {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  padding: 2px 0;
}
.v41pro-thinking-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 34px;
  padding: 0 8px;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
}
.v41pro-thinking-label {
  flex: 0 0 auto;
  white-space: nowrap;
}
.v41pro-thinking-current {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
  color: var(--dsw-alias-label-tertiary);
}
.v41pro-thinking-option {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 34px;
  padding: 5px 7px;
  border: none;
  border-radius: var(--dsw-radius-md);
  outline: none;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.v41pro-thinking-option:focus-visible {
  background: var(--dsw-alias-interactive-bg-hover);
}
@media (hover: hover) {
  .v41pro-thinking-option:hover:not(:disabled) {
    background: var(--dsw-alias-interactive-bg-hover);
  }
}
.v41pro-thinking-option:disabled {
  color: var(--dsw-alias-label-dimmed);
  cursor: default;
}
.v41pro-thinking-option-copy {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}
.v41pro-thinking-option-name {
  overflow: hidden;
  color: inherit;
  font-size: 13px;
  line-height: 18px;
  font-weight: 400;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.v41pro-thinking-option-floor {
  overflow: hidden;
  color: var(--dsw-alias-label-caption);
  font-size: 11px;
  line-height: 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.v41pro-thinking-check {
  display: grid;
  place-items: center;
  flex: 0 0 14px;
  color: var(--dsw-alias-label-primary);
}
.v41pro-thinking-check svg {
  width: 14px;
  height: 14px;
}
.v41pro-thinking-error {
  margin: 2px 7px 0;
  padding: 5px 7px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-interactive-bg-hover-danger);
  color: var(--dsw-alias-state-error-primary);
  font-size: 11px;
  line-height: 16px;
}
`

    /**
     * 思考模式菜单项。
     * @param {object} props - slot owner（locked/reportFailure）+ 标准 seat
     *   （useProjection/t）+ 注入的 setThinkingMode。
     */
    function ThinkingModeControl(props) {
      const { useProjection, locked, reportFailure, t, setThinkingMode } = props
      const view = useProjection('v41proThinking')
      const [pending, setPending] = useState(false)
      const [error, setError] = useState(null)

      // 投影缺失 = 能力未挂载（Host 单元没起来），不渲染。
      if (view === undefined || view === null) return null

      const mode = MODES.includes(view.mode) ? view.mode : 'auto'
      const phase = view.phase === 'focused' || view.phase === 'thorough' ? view.phase : 'divergent'

      /** 失败反馈：优先菜单所有者常驻 toast；无 reportFailure 时用组件内 role=alert 兜底。 */
      const notifyFailure = (message) => {
        if (typeof reportFailure === 'function') reportFailure(message)
        else setError(message)
      }

      /** 提交一次切换；正在保存或锁定时忽略，禁止并发重复保存。 */
      const choose = (next) => {
        if (next === mode || pending || locked) return
        setPending(true)
        setError(null)
        Promise.resolve(setThinkingMode(next)).then((failure) => {
          if (failure !== null && failure !== undefined) {
            notifyFailure(t('mode.failed', { message: String(failure) }))
          }
        }, (err) => {
          notifyFailure(t('mode.failed', {
            message: err instanceof Error ? err.message : String(err),
          }))
        }).finally(() => { setPending(false) })
      }

      const currentLabel = mode === 'auto'
        ? `${t('mode.option.auto')} · ${t('mode.phase.' + phase)}`
        : t('mode.option.' + mode)

      const options = MODES.map((value) => {
        const selected = value === mode
        const className = 'v41pro-thinking-option' + (selected ? ' v41pro-thinking-selected' : '')
        return h('button', {
          key: value,
          type: 'button',
          role: 'menuitemradio',
          'aria-checked': selected,
          className,
          disabled: locked || pending,
          onClick: () => choose(value),
        },
          h('span', { className: 'v41pro-thinking-option-copy' },
            h('span', { className: 'v41pro-thinking-option-name' }, t('mode.option.' + value)),
            h('span', { className: 'v41pro-thinking-option-floor' }, t('mode.floor.' + value)),
          ),
          selected ? h('span', { className: 'v41pro-thinking-check' }, CHECK_SVG) : null,
        )
      })

      return h(React.Fragment, null,
        h('style', null, CSS),
        h('div', { className: 'v41pro-thinking-root', role: 'group', 'aria-label': t('mode.label') },
          h('div', { className: 'v41pro-thinking-header' },
            h('span', { className: 'v41pro-thinking-label' }, t('mode.label')),
            h('span', { className: 'v41pro-thinking-current' }, currentLabel),
          ),
          options,
          error !== null ? h('div', { className: 'v41pro-thinking-error', role: 'alert' }, error) : null,
        ),
      )
    }


    // ===== 全模态设置页（内置自 ZTR66/dsh-omni，MIT）=====
    //
    // 与思考模式共用一个 factory：一个包只允许一个浏览器入口，id 必须等于包名。
    // 页面数据来自 Host 的 /api/omni 路由（omni/lib/settings-routes.js）。
    const API = '/api/omni';

    // ---- styles ---------------------------------------------------------
    //
    // Every colour is a theme alias so light and dark both work. Copied in shape
    // from the Host's Plugins page rather than imported from it: importing a Host
    // package would couple this plugin to an internal module path.
    const S = {
      page: {
        display: 'flex',
        flexDirection: 'column',
        gap: 24,
        padding: '4px 2px 32px',
        fontFamily: 'Inter, var(--dsw-font-family), system-ui, sans-serif',
        color: 'var(--dsw-alias-label-primary)',
      },
      section: {
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      },
      heading: {
        fontSize: 14,
        fontWeight: 600,
        margin: 0,
      },
      hint: {
        fontSize: 12,
        lineHeight: 1.6,
        color: 'var(--dsw-alias-label-secondary)',
        margin: 0,
      },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 10,
        padding: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      field: {
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      },
      label: {
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary)',
      },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '7px 10px',
        fontSize: 13,
        fontFamily: 'inherit',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 8,
        outline: 'none',
      },
      row: {
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        flexWrap: 'wrap',
      },
      button: {
        padding: '7px 14px',
        fontSize: 13,
        fontFamily: 'inherit',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 8,
        cursor: 'pointer',
      },
      primary: {
        padding: '7px 14px',
        fontSize: 13,
        fontFamily: 'inherit',
        fontWeight: 500,
        color: 'var(--dsw-alias-bg-base)',
        background: 'var(--dsw-alias-brand-primary)',
        border: '1px solid var(--dsw-alias-brand-primary)',
        borderRadius: 8,
        cursor: 'pointer',
      },
      danger: {
        padding: '5px 10px',
        fontSize: 12,
        fontFamily: 'inherit',
        color: 'var(--dsw-alias-state-error-primary)',
        background: 'transparent',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 8,
        cursor: 'pointer',
      },
      badge: {
        fontSize: 11,
        padding: '2px 7px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-l1)',
        color: 'var(--dsw-alias-label-secondary)',
      },
      badgeOk: {
        fontSize: 11,
        padding: '2px 7px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-brand-primary)',
      },
      badgeBad: {
        fontSize: 11,
        padding: '2px 7px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-state-error-primary)',
        color: 'var(--dsw-alias-state-error-primary)',
      },
      mono: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 12,
      },
      pre: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 11.5,
        lineHeight: 1.7,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        margin: 0,
        padding: 12,
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        maxHeight: 320,
        overflow: 'auto',
        color: 'var(--dsw-alias-label-secondary)',
      },
    };

    /**
     * Placeholder examples, per provider kind.
     *
     * These are hints for someone adding their first provider, so they name the
     * model families people actually reach for. The previous text used this
     * plugin's own
     * first test provider (`mona` / `gpt-free`), which read as "this is the only
     * supported service" rather than "here is the shape of the value".
     */
    const EXAMPLES = {
      image: {
        id: 'openai',
        name: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        keyRef: 'OPENAI_API_KEY',
        models: 'gpt-image-1, gpt-image-1-mini',
      },
    };

    /** One labelled text input. */
    function Field({ label, value, onChange, placeholder, mono }) {
      return h('label', { style: S.field },
        h('span', { style: S.label }, label),
        h('input', {
          type: 'text',
          value: value ?? '',
          placeholder: placeholder ?? '',
          onChange: (event) => onChange(event.target.value),
          spellCheck: false,
          style: mono === true ? { ...S.input, ...S.mono } : S.input,
        }));
    }

    /** One provider card: its fields and its key status. */
    function ProviderCard({ provider, onChange, onRemove, kind }) {
      const set = (patch) => onChange({ ...provider, ...patch });
      const example = EXAMPLES[kind] ?? EXAMPLES.image;
      return h('div', { style: S.card },
        h('div', { style: S.row },
          h('span', { style: { ...S.heading, fontSize: 13 } }, provider.name || provider.id || '（未命名）'),
          provider.hasKey === true
            ? h('span', { style: S.badgeOk }, '密钥就绪')
            : h('span', { style: S.badgeBad }, '缺少密钥'),
          h('span', { style: S.badge }, '图片'),
          h('div', { style: { flex: 1 } }),
          h('button', { type: 'button', style: S.danger, onClick: onRemove }, '移除')),
        h(Field, {
          label: '标识（唯一，用于工具调用时指定）',
          value: provider.id,
          onChange: (v) => set({ id: v }),
          placeholder: example.id,
          mono: true,
        }),
        h(Field, {
          label: '显示名称',
          value: provider.name,
          onChange: (v) => set({ name: v }),
          placeholder: example.name,
        }),
        h(Field, {
          label: 'API 地址',
          value: provider.baseUrl,
          onChange: (v) => set({ baseUrl: v }),
          placeholder: example.baseUrl,
          mono: true,
        }),
        h(Field, {
          label: '凭据引用名，或直接填密钥（保存时会自动移入凭据库）',
          value: provider.apiKeyEnv,
          onChange: (v) => set({ apiKeyEnv: v }),
          placeholder: example.keyRef,
          mono: true,
        }),
        h(Field, {
          label: '模型 id（逗号分隔，第一个为默认）',
          value: (provider.models ?? []).join(', '),
          onChange: (v) => set({ models: v.split(',').map((m) => m.trim()).filter((m) => m !== '') }),
          placeholder: example.models,
          mono: true,
        }));
    }

    /** The page. */
    function OmniSettings() {
      const [state, setState] = useState(null);
      const [error, setError] = useState('');
      const [saving, setSaving] = useState(false);
      const [savedAt, setSavedAt] = useState(0);
      const [checkText, setCheckText] = useState('');
      const [notes, setNotes] = useState([]);
      const [checking, setChecking] = useState(false);

      const load = useCallback(async () => {
        try {
          const response = await fetch(`${API}/settings`, { cache: 'no-store' });
          const data = await response.json();
          if (data?.ok === true) {
            setState(data);
            setError('');
          }
          else {
            setError(data?.error ?? '读取配置失败');
          }
        }
        catch (fetchError) {
          setError(String(fetchError?.message ?? fetchError));
        }
      }, []);

      useEffect(() => { load(); }, [load]);

      const save = useCallback(async () => {
        if (state === null) return;
        setSaving(true);
        try {
          const response = await fetch(`${API}/settings`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              image: { providers: state.image.providers },
              asr: state.asr,
              ffmpegPath: state.ffmpegPath,
              pythonPath: state.pythonPath,
            }),
          });
          const data = await response.json();
          if (data?.ok === true) {
            setSavedAt(Date.now());
            setError('');
            // The Host moves a pasted secret into the credential store and
            // rewrites the field to a reference name. Saying so explains why the
            // input changed after saving.
            setNotes(Array.isArray(data.notes) ? data.notes : []);
            await load();
          }
          else {
            setError(data?.error ?? '保存失败');
          }
        }
        catch (saveError) {
          setError(String(saveError?.message ?? saveError));
        }
        finally {
          setSaving(false);
        }
      }, [state, load]);

      const runCheck = useCallback(async () => {
        setChecking(true);
        try {
          const response = await fetch(`${API}/check`, { cache: 'no-store' });
          const data = await response.json();
          setCheckText(data?.ok === true ? data.text : `检测失败：${data?.error ?? ''}`);
        }
        catch (checkError) {
          setCheckText(`检测失败：${String(checkError?.message ?? checkError)}`);
        }
        finally {
          setChecking(false);
        }
      }, []);

      if (state === null) {
        return h('div', { style: S.page }, h('p', { style: S.hint }, error || '正在读取配置…'));
      }

      const updateProvider = (kind, index, next) => {
        setState((current) => {
          const list = [...current[kind].providers];
          list[index] = next;
          return { ...current, [kind]: { ...current[kind], providers: list } };
        });
      };
      const removeProvider = (kind, index) => {
        setState((current) => ({
          ...current,
          [kind]: { providers: current[kind].providers.filter((_, i) => i !== index) },
        }));
      };
      const addProvider = (kind) => {
        const example = EXAMPLES[kind] ?? EXAMPLES.image;
        setState((current) => ({
          ...current,
          [kind]: {
            providers: [
              ...current[kind].providers,
              // Pre-fill the fields with the example rather than leaving them
              // blank. A blank card gives no clue what a valid base URL or model
              // id looks like; a filled one only needs the key pasted in and the
              // wrong values are obvious to correct.
              {
                id: example.id,
                name: example.name,
                baseUrl: example.baseUrl,
                apiKeyEnv: '',
                models: example.models.split(',').map((m) => m.trim()).filter((m) => m !== ''),
                hasKey: false,
              },
            ],
          },
        }));
      };

      const renderProviders = (kind, title, hint) => h('section', { style: S.section },
        h('h3', { style: S.heading }, title),
        h('p', { style: S.hint }, hint),
        ...state[kind].providers.map((provider, index) => h(ProviderCard, {
          key: `${kind}-${index}`,
          provider,
          kind,
          onChange: (next) => updateProvider(kind, index, next),
          onRemove: () => removeProvider(kind, index),
        })),
        h('div', null,
          h('button', { type: 'button', style: S.button, onClick: () => addProvider(kind) }, '+ 添加提供商')));

      return h('div', { style: S.page },
        h('section', { style: S.section },
          h('h3', { style: S.heading }, '媒体服务'),
          h('p', { style: S.hint },
            '这里配置图片生成服务。视频不再接生成 API，交给 dsh-remotion 用代码渲染。密钥不写在这个页面：填的是 DSH 凭据库里的引用名，',
            '密钥本身通过凭据管理设置。ASR 默认走本地模型，不需要任何服务。')),

        error !== '' ? h('div', { style: { ...S.card, borderColor: 'var(--dsw-alias-state-error-primary)' } },
          h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } }, error)) : null,

        renderProviders('image', '图片生成',
          '内置适配：OpenAI、GPT-Image、Gemini、硅基流动、火山方舟 Seedream、智谱 CogView、百炼通义万相、Mona，以及本地 A1111。'),
        h('section', { style: S.section },
          h('h3', { style: S.heading }, '视频'),
          h('p', { style: S.hint },
            '不再接视频生成 API。视频改由 dsh-remotion 用 React/Remotion 逐帧渲染成本地 MP4；'
            + '装好该插件后让模型写工程再渲染，或直接用 video_compose 拼接已有素材。')),

        h('section', { style: S.section },
          h('h3', { style: S.heading }, '语音识别'),
          h('p', { style: S.hint }, 'auto 会先用宿主注册的识别器，没有再退回本地 faster-whisper。'),
          h('div', { style: S.row },
            h('label', { style: S.field },
              h('span', { style: S.label }, '模式'),
              h('select', {
                value: state.asr.mode,
                onChange: (event) => setState({ ...state, asr: { ...state.asr, mode: event.target.value } }),
                style: S.input,
              },
                h('option', { value: 'auto' }, 'auto（宿主优先，本地兜底）'),
                h('option', { value: 'local' }, 'local（只用本地模型）'),
                h('option', { value: 'cloud' }, 'cloud（只用宿主/云端）'))),
            h('label', { style: S.field },
              h('span', { style: S.label }, '本地模型'),
              h('select', {
                value: state.asr.localModel,
                onChange: (event) => setState({ ...state, asr: { ...state.asr, localModel: event.target.value } }),
                style: S.input,
              },
                h('option', { value: 'tiny' }, 'tiny（39MB，最快，精度一般）'),
                h('option', { value: 'base' }, 'base（74MB）'),
                h('option', { value: 'small' }, 'small（244MB，推荐）'),
                h('option', { value: 'medium' }, 'medium（769MB，慢）'))))),

        h('section', { style: S.section },
          h('h3', { style: S.heading }, '高级'),
          h(Field, {
            label: 'ffmpeg 路径（留空则用 PATH 或内置查找）',
            value: state.ffmpegPath,
            onChange: (v) => setState({ ...state, ffmpegPath: v }),
            placeholder: 'D:\\ffmpeg\\bin\\ffmpeg.exe',
            mono: true,
          }),
          h(Field, {
            label: 'Python 路径（留空则自动探测）',
            value: state.pythonPath,
            onChange: (v) => setState({ ...state, pythonPath: v }),
            placeholder: '自动探测',
            mono: true,
          })),

        h('div', { style: S.row },
          h('button', { type: 'button', style: S.primary, disabled: saving, onClick: save },
            saving ? '保存中…' : '保存'),
          h('button', { type: 'button', style: S.button, disabled: checking, onClick: runCheck },
            checking ? '检测中…' : '重新检测环境'),
          savedAt > 0 && Date.now() - savedAt < 4000
            ? h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-brand-primary)' } }, '已保存')
            : null),

        notes.length > 0
          ? h('div', { style: { ...S.card } },
            h('span', { style: { ...S.label, color: 'var(--dsw-alias-brand-primary)' } }, '已处理'),
            ...notes.map((note, index) => h('span', { key: index, style: S.hint }, note)))
          : null,

        checkText !== '' ? h('pre', { style: S.pre }, checkText) : null);
    }

    /** Nav icon: a small film-frame mark. */
    function OmniSettingsIcon() {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: 16,
        height: 16,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        'aria-hidden': true,
        style: { display: 'block' },
      },
        h('rect', { x: 3, y: 5, width: 18, height: 14, rx: 2 }),
        h('path', { d: 'M3 9h18M7 5v14M17 5v14' }));
    }

    return {
      inject: ['slots', 'locale', 'remote', 'remote.commands'],
      apply(ctx) {
        ctx.effect(
          () => ctx.locale.register(NS, { zh, en }),
          'v41pro-thinking: dictionaries',
        )
        ctx.slots.inject('conversation.input.model.options', () => ctx.slots.register({
          name: 'conversation.input.model.options',
          id: 'v41pro-thinking',
          order: 10,
          locale: NS,
          inject: (sessionId) => ({
            /**
             * 通过会话命令提交思考模式。
             * @param {string} next - auto | divergent | focused | thorough | off
             * @returns {Promise<string|null>} null 表示已受理；否则为失败文案。
             */
            setThinkingMode: async (next) => {
              let result
              try {
                result = await ctx.remote.commands.execute(sessionId, `/thinking ${next}`, [])
              } catch (error) {
                return error instanceof Error ? error.message : String(error)
              }
              if (!result.ok) return `${result.error.message} (${result.error.code})`
              if (result.value === undefined) return `unknown command: /thinking ${next}`
              const outcome = result.value && result.value.result
              if (outcome && outcome.kind === 'error') return outcome.text || 'command failed'
              return null
            },
          }),
        }, ThinkingModeControl))

        // 全模态设置页：导航图标 + 页面本体，order 与独立安装时保持一致。
        ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
          name: 'settings.section.icon',
          id: 'omni-media',
          order: 62,
        }, OmniSettingsIcon))

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'omni-media',
          order: 62,
          label: '全模态',
        }, OmniSettings))
      },
    }
  },
})
