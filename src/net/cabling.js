// Règles de câblage : quel câble entre deux ports, et pourquoi un lien reste éteint.
import { CABLES, MDI, MEDIA_LABEL, TYPES } from './catalog.js';

const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);

// Un équipement : { type, mdi? } ; mdi = 'auto' pour un modèle auto-MDI/MDIX (MikroTik)
const mdiOf = (x) => x.mdi ?? MDI[x.type];

// Câble cuivre attendu entre deux équipements (null : les deux conviennent)
export function expectedCopper(x, y) {
  const [a, b] = [mdiOf(x), mdiOf(y)];
  if (!a || !b || a === 'auto' || b === 'auto') return null;
  return a === b ? 'cross' : 'straight';
}

// Câble que poserait l'outil « automatique » de Packet Tracer entre deux ports
export function autoCable(x, portA, y, portB) {
  const media = new Set([portA.media, portB.media]);
  if (media.has('console') && media.has('rs232')) return 'console';
  if (media.size !== 1) return null;
  if (portA.media === 'copper') return expectedCopper(x, y) ?? 'straight';
  if (portA.media === 'fiber') return 'fiber';
  if (portA.media === 'serial') return 'serial';
  return null;
}

// Choisit les ports à relier pour un nouveau câble.
//   a, b : { label, type, mdi?, free: [ports libres] } ; tool : 'auto' ou un id de CABLES
// Renvoie { portA, portB, cable } ou { error }
export function pickPorts(a, b, tool = 'auto') {
  const first = (side, media) => side.free.find((p) => p.media === media);

  if (tool === 'console') {
    for (const [x, y, flip] of [[a, b, false], [b, a, true]]) {
      const c = first(x, 'console');
      const r = first(y, 'rs232');
      if (c && r) return flip ? { portA: r, portB: c, cable: 'console' } : { portA: c, portB: r, cable: 'console' };
    }
    return { error: 'Un câble console relie le port RS232 d\'un PC au port Console libre d\'un routeur ou d\'un switch.' };
  }

  const order = tool === 'auto' ? ['copper', 'fiber', 'serial'] : [CABLES[tool].media];
  for (const media of order) {
    const pa = first(a, media);
    const pb = first(b, media);
    if (pa && pb) return { portA: pa, portB: pb, cable: tool === 'auto' ? autoCable(a, pa, b, pb) : tool };
  }

  const what = tool === 'auto' ? 'réseau' : MEDIA_LABEL[CABLES[tool].media];
  const missing = [a, b].filter((x) => !order.some((m) => first(x, m))).map((x) => x.label);
  if (missing.length) {
    return { error: `Plus de port ${what} libre sur ${missing.join(' et ')}. Ajoute un module, change de modèle ou retire un câble.` };
  }
  return { error: `${a.label} et ${b.label} n'ont pas de port ${what} libre du même type (cuivre, fibre ou série).` };
}

// État d'un câble.
//   a, b    : { label, type, mdi?, port: { name, media } | null, portName }
//   cable   : id de CABLES
//   dce     : 'a' | 'b' (liaison série) ; clockRate : clock rate configuré côté DCE
// Renvoie { up, data, reason } ; data = le câble transporte du trafic réseau
export function checkLink(a, b, cable, { dce = 'a', clockRate = null } = {}) {
  const spec = CABLES[cable];
  const end = (x) => `${x.label} ${x.port?.name ?? x.portName}`;
  const data = cable !== 'console';

  for (const x of [a, b]) {
    if (!x.port) return { up: false, data, reason: `${x.label} n'a pas de port ${x.portName ?? '?'} : change de port ou ajoute le module.` };
  }
  if (!spec) return { up: false, data, reason: `Type de câble inconnu : ${cable}.` };

  if (cable === 'console') {
    const media = new Set([a.port.media, b.port.media]);
    if (media.has('console') && media.has('rs232')) return { up: true, data: false, reason: null };
    return { up: false, data: false, reason: `Câble console entre ${end(a)} et ${end(b)} : il relie un port RS232 à un port Console.` };
  }

  for (const x of [a, b]) {
    if (x.port.media !== spec.media) {
      return {
        up: false, data,
        reason: `Un câble ${lower(spec.label)} ne se branche pas sur ${end(x)} (port ${MEDIA_LABEL[x.port.media]}).`,
      };
    }
  }

  if (spec.media === 'copper') {
    const expected = expectedCopper(a, b);
    if (expected && expected !== cable) {
      const pair = a.type === b.type ? TYPES[a.type].two : `${TYPES[a.type].one} et ${TYPES[b.type].one}`;
      return {
        up: false, data,
        reason: `Câble ${lower(spec.label)} entre ${a.label} et ${b.label} : ${pair} se relient avec un câble ${lower(CABLES[expected].label)}.`,
      };
    }
  }

  if (spec.media === 'serial') {
    // Seuls les routeurs ont des ports série : les deux extrémités sont donc des routeurs
    const side = dce === 'b' ? b : a;
    if (!clockRate) {
      return {
        up: false, data,
        reason: `Liaison série ${end(a)} ↔ ${end(b)} : le côté DCE (${end(side)}) n'a pas de clock rate, la ligne reste down.`,
      };
    }
  }

  return { up: true, data, reason: null };
}
