import { Icon } from "./ui";
import type { Skill } from "../lib/skill";

interface SkillChipsProps {
  skills: Skill[];
  active: string[];
  disabled?: boolean;
  onToggle: (id: string) => void;
  onOpen: () => void;
}

/**
 * 输入框上方的技能条：只显示已启用的技能，点 × 关掉，点「技能」开面板。
 * 常态下不占地方——没启用任何技能时只剩一个小按钮。
 */
export function SkillChips({ skills, active, disabled, onToggle, onOpen }: SkillChipsProps) {
  const on = skills.filter((s) => active.includes(s.id));

  return (
    <div className="skill-chips" id="skillChips">
      {on.map((s) => (
        <span className="skill-chip" key={s.id} data-id={s.id} title={s.description}>
          <span className="skill-chip-name">{s.name}</span>
          <button
            className="skill-chip-x"
            type="button"
            title="关闭这个技能"
            aria-label={"关闭 " + s.name}
            disabled={disabled}
            onClick={() => onToggle(s.id)}
          >
            <Icon name="close" size={12} />
          </button>
        </span>
      ))}
      <button className="skill-open" id="btnSkills" type="button" title="技能库" onClick={onOpen}>
        <Icon name="layers" size={14} />
        <span>{on.length ? `技能 ${on.length}` : "技能"}</span>
      </button>
    </div>
  );
}
