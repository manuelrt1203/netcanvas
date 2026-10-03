import { useEffect, useRef, useState } from 'react';
import { runLine, shellFor } from './cli/index.js';

// Session d'un équipement : gardée quand on change de sélection (mode, historique, écran)
function getSession(store, device, shell) {
  let s = store.get(device.id);
  if (!s || s.shell !== shell) {
    s = { shell, state: shell.newSession(), lines: shell.banner(device), history: [] };
    store.set(device.id, s);
  }
  return s;
}

const MAX_LINES = 1000;

export default function Terminal({ device, doc, sessions, onChange, onPing }) {
  const shell = shellFor(device);
  const session = getSession(sessions, device, shell);
  const [lines, setLines] = useState(session.lines);
  const [input, setInput] = useState('');
  const [cursor, setCursor] = useState(null); // position dans l'historique
  const screen = useRef(null);
  const field = useRef(null);
  const prompt = shell.prompt(session.state, device);

  useEffect(() => {
    screen.current.scrollTop = screen.current.scrollHeight;
  }, [lines]);

  const print = (more) => {
    const next = [...session.lines, ...more].slice(-MAX_LINES);
    session.lines = next;
    setLines(next);
  };

  const submit = (line) => {
    const echo = `${prompt}${line}`;
    const r = runLine(shell, session.state, line, device, doc);
    if (line.trim()) session.history = [...session.history.filter((h) => h !== line), line].slice(-100);
    if (r.effects.some((e) => e.type === 'clear')) {
      session.lines = [];
      setLines([]);
    } else print([echo, ...r.output]);
    if (r.device) onChange(r.device);
    for (const e of r.effects) if (e.type === 'ping') onPing(e.source, e.target);
    setInput('');
    setCursor(null);
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit(input);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      setInput(shell.complete(session.state, input, device));
    } else if (e.key === '?') {
      // Comme sur IOS : l'aide s'affiche tout de suite, la ligne reste à compléter
      e.preventDefault();
      print([`${prompt}${input}?`, ...shell.help(session.state, `${input}?`, device)]);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const h = session.history;
      if (!h.length) return;
      const i = cursor === null ? (e.key === 'ArrowUp' ? h.length - 1 : null) : cursor + (e.key === 'ArrowUp' ? -1 : 1);
      if (i === null || i >= h.length) {
        setCursor(null);
        setInput('');
      } else {
        const j = Math.max(0, i);
        setCursor(j);
        setInput(h[j]);
      }
    } else if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) {
      e.preventDefault();
      print([`${prompt}${input}^C`]);
      setInput('');
    } else if (e.ctrlKey && (e.key === 'z' || e.key === 'Z')) {
      // Ctrl+Z : sortie du mode configuration (IOS)
      e.preventDefault();
      if (session.state.mode && !['user', 'priv'].includes(session.state.mode)) submit('end');
    } else if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) {
      e.preventDefault();
      session.lines = [];
      setLines([]);
    }
  };

  return (
    // Un clic n'importe où dans le terminal place le curseur dans la ligne de commande
    <div className="terminal" onClick={() => window.getSelection()?.isCollapsed && field.current?.focus()}>
      <pre ref={screen} className="terminal-screen" role="log" aria-live="polite" aria-label={`Terminal de ${device.label}`}>
        {lines.join('\n')}
        {lines.length ? '\n' : ''}
        <span className="terminal-line">
          <span className="terminal-prompt">{prompt}</span>
          <input
            ref={field}
            className="terminal-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            aria-label="Commande"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck="false"
            autoFocus
          />
        </span>
      </pre>
    </div>
  );
}
