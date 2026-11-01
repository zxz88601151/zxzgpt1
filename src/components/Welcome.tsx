import { WELCOME_CHIPS } from "../presets";
import avatarHero from "../assets/avatar.png";

/** 人像 + 右下角 z 角标，表示「你 ⇄ zxz」；两种空状态共用 */
function Hero() {
  return (
    <div className="hero">
      <img className="hero-avatar" src={avatarHero} alt="我的头像" draggable={false} />
      <span className="hero-badge">z</span>
    </div>
  );
}

/** 空会话时的欢迎页；noConv 用于「一个会话都没有」的情形 */
export function Welcome({ model, noConv, onChip }: { model: string; noConv?: boolean; onChip: (text: string) => void }) {
  if (noConv) {
    return (
      <div className="welcome">
        <Hero />
        <h2>开始一段对话</h2>
        <p>点击左上角「新建对话」，然后在设置里填入 API Key</p>
      </div>
    );
  }

  return (
    <div className="welcome">
      <Hero />
      <h2>有什么可以帮你的？</h2>
      <p>
        当前模型：<b>{model || "尚未配置"}</b> · 在左下角「设置」中接入任意 OpenAI 兼容接口
      </p>
      <div className="chips">
        {WELCOME_CHIPS.map((chip) => (
          <button key={chip.title} className="chip" type="button" onClick={() => onChip(chip.body)}>
            <b>{chip.title}</b>
            <span>{chip.body}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
