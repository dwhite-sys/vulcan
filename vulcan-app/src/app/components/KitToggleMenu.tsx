import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Package } from 'lucide-react';
import type { Kit } from '../types/vulcan';

interface KitToggleMenuProps {
  kits: Kit[];
  onToggleKit: (kitName: string, enabled: boolean) => void;
}

export function KitToggleMenu({ kits, onToggleKit }: KitToggleMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Position the portal popup above the button
  const openMenu = () => {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setMenuPos({
        top: rect.top - 8, // will be adjusted to sit above via transform
        left: rect.left,
      });
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

  const enabledCount = kits.filter((k) => k.enabled).length;

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
          {enabledCount} of {kits.length} kits enabled
        </p>
      </div>
      <div className="max-h-80 overflow-y-auto">
        {kits.length === 0 ? (
          <div className="p-4 text-center text-ash-500 text-sm">No kits available</div>
        ) : (
          <div className="p-1">
            {kits.map((kit) => (
              <div
                key={kit.kit_name}
                className="flex items-center justify-between p-2 hover:bg-ash-800/50 rounded-md"
              >
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <Package className="w-4 h-4 text-ash-400 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-ash-200 truncate">{kit.kit_name}</p>
                    {kit.kit_description && (
                      <p className="text-xs text-ash-500 truncate">{kit.kit_description}</p>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => onToggleKit(kit.kit_name, !kit.enabled)}
                  className="relative ml-2 flex-shrink-0"
                >
                  <div className={`w-10 h-5 rounded-full transition-colors ${kit.enabled ? 'bg-coral-500' : 'bg-ash-700'}`}>
                    <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-transform ${kit.enabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
                  </div>
                </button>
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
        <Package className="w-4 h-4" />
        <span>Kits</span>
        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>
      {popup}
    </>
  );
}
