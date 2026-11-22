import React from 'react';
import {
  AbsoluteFill,
  Composition,
  interpolate,
  registerRoot,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

const ACCENT = '#F26445';
const PAPER = '#FFF8ED';
const MUTED = '#93A6AF';
const FONT = '"Microsoft YaHei", "PingFang SC", "Segoe UI", system-ui, sans-serif';

const rise = (frame, start, fps, dist = 28) => {
  const s = spring({ frame: frame - start, fps, config: { damping: 200, mass: 0.7 } });
  return { opacity: s, transform: `translateY(${(1 - s) * dist}px)` };
};

const fadeOut = (frame, start, end) =>
  interpolate(frame, [start, end], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

const GROUPS = [
  {
    name: '规划与推进',
    items: [
      ['escalator', '升级与重试，不让任务卡在第一次失败'],
      ['tempo', '节奏与并发，长任务按步推进'],
      ['ledger', '目标、改动、证据持久化'],
      ['cartographer', '先画依赖地图，再动手'],
    ],
  },
  {
    name: '验证与对抗',
    items: [
      ['verifier', '真跑命令取证，不假装通过'],
      ['critic', '独立复审，默认 fail-closed'],
      ['forker', '并行候选，选一个做完'],
      ['novel', '长篇连续性，不漂移'],
    ],
  },
  {
    name: '表达与媒介',
    items: [
      ['thinking', '发散拆解，聚焦攻坚'],
      ['language', '语言与结构，先想清再动手'],
      ['fiction', '小说写作，人物与钩子'],
      ['omni', '看懂音视频素材，拼成成片'],
    ],
  },
];

const Card = ({ name, desc, index, start, fps }) => {
  const frame = useCurrentFrame();
  const style = rise(frame, start, fps, 22);
  return (
    <div
      style={{
        ...style,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: 8,
        padding: '0 22px',
        height: 96,
        borderRadius: 14,
        background: 'rgba(255,248,237,0.045)',
        border: '1px solid rgba(255,248,237,0.10)',
      }}
    >
      <div style={{ fontSize: 30, fontWeight: 700, color: PAPER, letterSpacing: 0.4 }}>{name}</div>
      <div style={{ fontSize: 21, color: MUTED, lineHeight: 1.35 }}>{desc}</div>
    </div>
  );
};

const Video = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const progress = frame / (durationInFrames - 1);

  return (
    <AbsoluteFill
      style={{
        background: 'linear-gradient(135deg, #0A1419 0%, #122430 58%, #0E1A21 100%)',
        fontFamily: FONT,
        color: PAPER,
        overflow: 'hidden',
      }}
    >
      {/* 顶部细光线 */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          height: 2,
          width: 1920 * progress,
          background: `linear-gradient(90deg, transparent, ${ACCENT})`,
          opacity: 0.6,
        }}
      />

      {/* 场景 1：标题 */}
      {frame < 110 ? (
        <AbsoluteFill
          style={{
            alignItems: 'center',
            justifyContent: 'center',
            opacity: fadeOut(frame, 92, 110),
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, ...rise(frame, 4, fps, 16) }}>
            <div style={{ width: 16, height: 16, background: ACCENT, borderRadius: 3 }} />
            <div style={{ fontSize: 22, letterSpacing: 6, color: MUTED }}>DEEPSEEK HARNESS</div>
          </div>
          <div
            style={{
              ...rise(frame, 10, fps, 40),
              fontSize: 168,
              fontWeight: 800,
              letterSpacing: -6,
              lineHeight: 1.05,
              marginTop: 18,
            }}
          >
            v41pro
          </div>
          <div style={{ ...rise(frame, 22, fps, 24), fontSize: 40, color: MUTED, marginTop: 12 }}>
            十二个模块 · 一个插件
          </div>
          <div
            style={{
              marginTop: 34,
              height: 5,
              width: interpolate(frame, [26, 60], [0, 160], {
                extrapolateLeft: 'clamp',
                extrapolateRight: 'clamp',
              }),
              background: ACCENT,
              borderRadius: 4,
            }}
          />
        </AbsoluteFill>
      ) : null}

      {/* 场景 2：命题 */}
      {frame >= 110 && frame < 210 ? (
        <AbsoluteFill
          style={{ alignItems: 'center', justifyContent: 'center', opacity: fadeOut(frame, 192, 210) }}
        >
          <div style={{ ...rise(frame, 116, fps), fontSize: 66, fontWeight: 700, color: PAPER }}>
            Agent 说做了，不等于做了。
          </div>
          <div style={{ ...rise(frame, 146, fps), fontSize: 66, fontWeight: 700, color: ACCENT, marginTop: 26 }}>
            v41pro 让每一步都能被验证。
          </div>
        </AbsoluteFill>
      ) : null}

      {/* 场景 3：模块矩阵 */}
      {frame >= 205 && frame < 672 ? (
        <AbsoluteFill style={{ padding: '96px 140px', opacity: fadeOut(frame, 652, 672) }}>
          <div style={{ ...rise(frame, 210, fps, 20), fontSize: 24, letterSpacing: 6, color: ACCENT }}>
            12 MODULES
          </div>
          <div style={{ ...rise(frame, 216, fps, 22), fontSize: 58, fontWeight: 700, marginTop: 12 }}>
            每个模块只做一件事
          </div>
          <div style={{ display: 'flex', gap: 100, marginTop: 56 }}>
            {GROUPS.map((group, gi) => (
              <div key={group.name} style={{ width: 480 }}>
                <div
                  style={{
                    ...rise(frame, 226 + gi * 6, fps, 16),
                    fontSize: 27,
                    fontWeight: 700,
                    color: PAPER,
                    paddingBottom: 14,
                    borderBottom: `1px solid rgba(242,100,69,0.5)`,
                    marginBottom: 18,
                  }}
                >
                  {group.name}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  {group.items.map(([name, desc], ii) => (
                    <Card
                      key={name}
                      name={name}
                      desc={desc}
                      index={ii}
                      start={238 + gi * 12 + ii * 9}
                      fps={fps}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </AbsoluteFill>
      ) : null}

      {/* 场景 4：交付流程 */}
      {frame >= 665 && frame < 812 ? (
        <AbsoluteFill
          style={{ alignItems: 'center', justifyContent: 'center', opacity: fadeOut(frame, 794, 812) }}
        >
          <div style={{ ...rise(frame, 670, fps), fontSize: 56, fontWeight: 700 }}>一次交付，四道关</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginTop: 64 }}>
            {['拆解', '执行', '验证', '汇报'].map((label, i) => (
              <React.Fragment key={label}>
                {i > 0 ? (
                  <div style={{ fontSize: 34, color: ACCENT, ...rise(frame, 690 + i * 22, fps, 10) }}>→</div>
                ) : null}
                <div
                  style={{
                    ...rise(frame, 682 + i * 22, fps, 26),
                    width: 250,
                    height: 128,
                    borderRadius: 16,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 44,
                    fontWeight: 700,
                    background: 'rgba(242,100,69,0.10)',
                    border: '1px solid rgba(242,100,69,0.45)',
                  }}
                >
                  {label}
                </div>
              </React.Fragment>
            ))}
          </div>
          <div style={{ ...rise(frame, 776, fps), fontSize: 26, color: MUTED, marginTop: 46 }}>
            想清楚 → 真执行 → 拿证据 → 说人话
          </div>
        </AbsoluteFill>
      ) : null}

      {/* 场景 5：尾卡 */}
      {frame >= 805 ? (
        <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ ...rise(frame, 810, fps, 34), fontSize: 104, fontWeight: 800, letterSpacing: -3 }}>
            dsh-v41-pro
          </div>
          <div style={{ ...rise(frame, 826, fps, 22), fontSize: 36, color: ACCENT, marginTop: 16 }}>
            十二个模块 · 一个插件 · MIT
          </div>
          <div style={{ ...rise(frame, 842, fps, 18), fontSize: 25, color: MUTED, marginTop: 22 }}>
            本地运行，无外部生成 API；配 dsh-remotion 就能用代码渲染成片
          </div>
        </AbsoluteFill>
      ) : null}

      {/* 进度条 */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          bottom: 0,
          height: 6,
          width: 1920 * progress,
          background: ACCENT,
          opacity: 0.85,
        }}
      />
    </AbsoluteFill>
  );
};

const Root = () => (
  <Composition id="Intro" component={Video} durationInFrames={900} fps={30} width={1920} height={1080} />
);

registerRoot(Root);
