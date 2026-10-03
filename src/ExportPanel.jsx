import { useMemo, useState } from 'react';
import { FORMATS, ciscoConfigs, fileName, formatById } from './export/index.js';

const FORMAT_KEY = 'netcanvas:export-format';

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Hors HTTPS l'API presse-papier est indisponible : repli sur execCommand
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Rasterise le SVG dans un canvas (x2 pour les écrans haute densité et l'impression)
function svgToPng(svg, scale = 2) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth * scale;
      canvas.height = img.naturalHeight * scale;
      const ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Conversion PNG impossible.'))), 'image/png');
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Conversion PNG impossible.'));
    };
    img.src = url;
  });
}

function readFormat() {
  try {
    return formatById(localStorage.getItem(FORMAT_KEY)).id;
  } catch {
    return FORMATS[0].id;
  }
}

export default function ExportPanel({ doc }) {
  const [formatId, setFormatId] = useState(readFormat);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const format = formatById(formatId);
  const isImage = format.id === 'svg' || format.id === 'png';

  const output = useMemo(() => format.build(doc), [format, doc]);
  const warnings = useMemo(() => {
    if (format.id !== 'packet-tracer' && format.id !== 'gns3') return [];
    return ciscoConfigs(doc, { target: format.id }).flatMap((c) => c.warnings.map((w) => `${c.label} : ${w}`));
  }, [format, doc]);
  const previewUrl = useMemo(() => (isImage ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(output)}` : null), [isImage, output]);

  const choose = (id) => {
    setFormatId(id);
    setError('');
    try {
      localStorage.setItem(FORMAT_KEY, id);
    } catch {
      /* stockage indisponible : on ignore */
    }
  };

  const save = async () => {
    setError('');
    try {
      const blob = format.binary ? await svgToPng(output) : new Blob([output], { type: `${format.mime};charset=utf-8` });
      download(blob, fileName(doc, format));
    } catch (err) {
      setError(err.message);
    }
  };

  const copy = async () => {
    await copyText(output);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <>
      <h2>Exporter</h2>
      <label htmlFor="export-format">Format</label>
      <select id="export-format" value={format.id} onChange={(e) => choose(e.target.value)}>
        {FORMATS.map((f) => (
          <option key={f.id} value={f.id}>{f.label}</option>
        ))}
      </select>
      <p className="hint">{format.help}</p>

      <div className="row">
        <button type="button" onClick={save} disabled={!doc.devices.length}>
          Télécharger <span className="ext">.{format.ext}</span>
        </button>
        {!format.binary && (
          <button type="button" className="ghost" onClick={copy} disabled={!doc.devices.length}>
            {copied ? 'Copié' : 'Copier'}
          </button>
        )}
      </div>
      {error && <p className="error" role="alert">{error}</p>}

      {warnings.length > 0 && (
        <div className="notice export-warnings">
          <strong>{warnings.length} point(s) à vérifier</strong>
          <ul>
            {warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}

      {!doc.devices.length ? (
        <p className="hint">Le schéma est vide : ajoute des équipements pour exporter.</p>
      ) : isImage ? (
        <img className="export-preview" src={previewUrl} alt={`Aperçu du schéma ${doc.name}`} />
      ) : (
        <pre className="json" data-testid="export-output">{output}</pre>
      )}
    </>
  );
}
