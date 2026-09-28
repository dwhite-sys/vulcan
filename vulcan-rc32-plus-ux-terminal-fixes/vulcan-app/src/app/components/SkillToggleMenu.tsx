import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, BookOpen } from 'lucide-react';

export interface SkillMeta {
  name: string;
  stem: string;
  description?: string;
  source: string;
  enabled: boolean;
}

interface SkillToggleMenuProps {
  skills: SkillMeta[];
  onToggleSkill: (stem: string, enabled: boolean) => void;
}

export function SkillToggleMenu({ skills, onToggleSkill }: SkillToggleMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const openMenu = () => {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setMenuPos({ top: rect.top - 8, left: rect.left });
    }
    setIsOpen(true);
  };

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (
        menuRef.current && !menuRef.current.contains(event.target as Node) &&
        buttonRef.current && !buttonRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const enabledCount = skills.filter((s) => s.enabled).length;

  const popup = isOpen && createPortal(
    <div
      ref={menuRef}
      style={{
        position: 'fixed',
        top: menuPos.top,
        left: menuPos.left,
        transform: 'translateY(-100%)',
        zIndex: 9999,
      }}
      className="w-64 bg-ash-900 border border-ash-700 rounded-lg shadow-2xl overflow-hidden"
    >
      <div className="p-2 border-b border-ash-800">
        <p className="text-xs text-ash-500">
          {enabledCount} of {skills.length} skills enabled
        </p>
      </div>
      <div className="max-h-80 overflow-y-auto">
        {skills.length === 0 ? (
          <div className="p-4 text-center text-ash-500 text-sm">No skills installed</div>
        ) : (
          <div className="p-1">
            {[
              { label: 'Vulcan', items: skills.filter((skill) => skill.source === 'vulcan') },
              { label: 'Etna', items: skills.filter((skill) => skill.source !== 'vulcan') },
            ].filter((category) => category.items.length > 0).map((category) => (
              <div key={category.label}>
                <p className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-ash-500">
                  {category.label}
                </p>
                {category.items.map((skill) => (
                  <div
                    key={skill.stem}
                    className="flex items-center justify-between p-2 hover:bg-ash-800/50 rounded-md"
                  >
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <BookOpen className="w-4 h-4 text-ash-400 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-ash-200 truncate">{skill.name}</p>
                        {skill.description && (
                          <p className="text-xs text-ash-500 truncate">{skill.description}</p>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => onToggleSkill(skill.stem, !skill.enabled)}
                      className="relative ml-2 flex-shrink-0"
                    >
                      <div className={`w-10 h-5 rounded-full transition-colors ${skill.enabled ? 'bg-coral-500' : 'bg-ash-700'}`}>
                        <div className={`absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full transition-transform ${skill.enabled ? 'translate-x-5' : 'translate-x-0'}`} />
                      </div>
                    </button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body
  );

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => (isOpen ? setIsOpen(false) : openMenu())}
        className="flex items-center gap-2 px-3 py-1.5 bg-ash-800 hover:bg-ash-700 border border-ash-700 rounded-md text-sm text-ash-300 transition-colors"
      >
        <BookOpen className="w-4 h-4" />
        <span>Skills</span>
        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>
      {popup}
    </>
  );
}
