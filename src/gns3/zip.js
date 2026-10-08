// Archives ZIP sans dépendance : lecture (stockée ou deflate, via DecompressionStream) et écriture (stockée).
// Un projet portable GNS3 (.gns3project) est un zip : project.gns3 + project-files/… (configs des routeurs, des VPCS).
// La lecture passe par le répertoire central : GNS3 écrit en flux (tailles à 0 dans les en-têtes locaux, ZIP64).

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const utf8 = new TextEncoder();

// files : [{ name, data: Uint8Array | string }] -> Uint8Array (méthode « stockée », sans compression)
export function writeZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = utf8.encode(f.name);
    const data = typeof f.data === 'string' ? utf8.encode(f.data) : f.data;
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // noms en UTF-8
    local.setUint16(8, 0, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, data);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const size = central.reduce((s, p) => s + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return concat([...parts, ...central, new Uint8Array(end.buffer)]);
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export const isZip = (bytes) => bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;

async function inflateRaw(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Renvoie Map<nom, () => Promise<Uint8Array>> ; `wanted(nom)` filtre ce qu'on décompresse (on saute les images disque)
export function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Archive ZIP illisible (fin du répertoire introuvable).');
  let count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  // ZIP64 : le vrai répertoire central est décrit par l'enregistrement ZIP64 qui précède
  if (at === 0xffffffff || count === 0xffff) {
    const loc = eocd - 20;
    if (loc >= 0 && view.getUint32(loc, true) === 0x07064b50) {
      const z64 = Number(view.getBigUint64(loc + 8, true));
      count = Number(view.getBigUint64(z64 + 32, true));
      at = Number(view.getBigUint64(z64 + 48, true));
    }
  }
  const entries = new Map();
  const decoder = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('Archive ZIP abîmée (répertoire central).');
    const method = view.getUint16(at + 10, true);
    let compressed = view.getUint32(at + 20, true);
    let size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    let local = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    // Champ supplémentaire ZIP64 : tailles et position sur 8 octets, seulement pour les valeurs à 0xffffffff
    for (let e = at + 46 + nameLen; e < at + 46 + nameLen + extraLen;) {
      const id = view.getUint16(e, true);
      const len = view.getUint16(e + 2, true);
      if (id === 0x0001) {
        let p = e + 4;
        if (size === 0xffffffff) { size = Number(view.getBigUint64(p, true)); p += 8; }
        if (compressed === 0xffffffff) { compressed = Number(view.getBigUint64(p, true)); p += 8; }
        if (local === 0xffffffff) local = Number(view.getBigUint64(p, true));
      }
      e += 4 + len;
    }
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + compressed);
    entries.set(name, async () => {
      if (method === 0) return data;
      if (method === 8) return inflateRaw(data);
      throw new Error(`${name} : compression ${method} non prise en charge.`);
    });
  }
  return entries;
}
