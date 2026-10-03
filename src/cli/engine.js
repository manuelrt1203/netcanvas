// Moteur d'arbre de commandes façon Cisco IOS : abréviations (« sh ip int br »), aide « ? »,
// complétion Tab et messages d'erreur avec le marqueur ^.
//
// Un nœud : { run?(ctx), children?: [enfant] }
// Un enfant : { kw: 'show', help } ou { arg: 'A.B.C.D', name, help, test(tok) } ou { arg, name, help, rest: true }
//   (rest : prend tout le reste de la ligne, ex. description), plus les champs d'un nœud.

// Constructeurs de nœuds
export const kw = (word, help, node = {}) => ({ kw: word, help, ...node });
export const arg = (name, label, help, test, node = {}) => ({ arg: label, name, help, test, ...node });
export const rest = (name, label, help, run) => ({ arg: label, name, help, rest: true, run });
// Commande acceptée sans effet (mot de passe, bannière…) : on ne bloque pas l'élève
export const accept = (word, help) => kw(word, help, { run() {}, children: [rest('x', 'LINE', '', () => {})] });

export function tokenize(line) {
  const tokens = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(line))) tokens.push({ text: m[0], start: m.index });
  return tokens;
}

// Enfant correspondant à un mot : mot-clé exact, sinon préfixe unique, sinon argument
function matchChild(node, tok, line) {
  const kids = node.children ?? [];
  const word = tok.text.toLowerCase();
  const kws = kids.filter((c) => c.kw);
  const exact = kws.find((c) => c.kw.toLowerCase() === word);
  if (exact) return { child: exact };
  const prefixed = kws.filter((c) => c.kw.toLowerCase().startsWith(word));
  if (prefixed.length === 1) return { child: prefixed[0] };
  if (prefixed.length > 1) return { ambiguous: prefixed };
  const arg = kids.find((c) => c.arg && (c.rest || !c.test || c.test(tok.text)));
  if (arg) return { child: arg, value: arg.rest ? line.slice(tok.start).trimEnd() : tok.text };
  return null;
}

// Parcourt la ligne : renvoie le nœud atteint et les arguments, ou une erreur
export function parse(root, line) {
  const tokens = tokenize(line);
  let node = root;
  const args = {};
  const path = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const m = matchChild(node, tok, line);
    if (!m) return { error: 'invalid', at: tok.start, tokens, index: i };
    if (m.ambiguous) return { error: 'ambiguous', tokens, index: i, options: m.ambiguous };
    node = m.child;
    path.push(node.kw ?? node.name);
    if (node.arg) {
      args[node.name] = m.value;
      if (node.rest) break;
    }
  }
  return { node, args, tokens, path };
}

export const invalidAt = (line, at, promptLen) => [
  `${' '.repeat(promptLen + at)}^`,
  "% Invalid input detected at '^' marker.",
  '',
];

// Aide « ? » : liste des mots possibles à cet endroit
export function help(root, line) {
  const body = line.replace(/\?$/, '');
  const partial = body && !/\s$/.test(body);
  const tokens = tokenize(body);
  const done = partial ? body.slice(0, tokens.at(-1).start) : body;
  const p = parse(root, done);
  if (p.error) return [`% Unrecognized command`];
  if (p.node.rest) return ['  LINE  <cr>'];

  const kids = p.node.children ?? [];
  if (partial) {
    const word = tokens.at(-1).text.toLowerCase();
    const list = kids.filter((c) => c.kw?.toLowerCase().startsWith(word)).map((c) => c.kw);
    return list.length ? [list.join('  '), ''] : ['% Unrecognized command'];
  }
  const rows = kids.map((c) => [c.kw ?? c.arg, c.help ?? '']);
  if (p.node.run) rows.push(['<cr>', '']);
  const w = Math.max(0, ...rows.map(([k]) => k.length));
  return [...rows.map(([k, h]) => `  ${k.padEnd(w)}  ${h}`.trimEnd()), ''];
}

// Complétion Tab du dernier mot (préfixe unique d'un mot-clé)
export function complete(root, line) {
  if (!line.trim() || /\s$/.test(line)) return line;
  const tokens = tokenize(line);
  const last = tokens.at(-1);
  const p = parse(root, line.slice(0, last.start));
  if (p.error || p.node.rest) return line;
  const word = last.text.toLowerCase();
  const list = (p.node.children ?? []).filter((c) => c.kw?.toLowerCase().startsWith(word));
  return list.length === 1 ? `${line.slice(0, last.start)}${list[0].kw} ` : line;
}

// Exécute une ligne ; renvoie les lignes d'erreur, ou null si la commande a été exécutée
export function execute(root, line, ctx, promptLen) {
  const p = parse(root, line);
  if (p.error === 'invalid') return invalidAt(line, p.at, promptLen);
  if (p.error === 'ambiguous') {
    return [`% Ambiguous command:  "${line.trim()}"`, ''];
  }
  if (!p.node.run) return ['% Incomplete command.', ''];
  // Même objet : la commande peut signaler ctx.changed, ajouter des effets…
  ctx.args = p.args;
  ctx.line = line;
  p.node.run(ctx);
  return null;
}
