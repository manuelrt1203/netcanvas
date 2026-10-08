// Import d'un projet GNS3 : projet portable (.gns3project), fichier .gns3 seul, ou dossier du projet
// (GNS3/projects/<nom>, avec project-files : configs des routeurs Dynamips, des VPCS et des conteneurs).
import { useRef, useState } from 'react';

const MAX_FILE = 1_000_000; // les images disque et la RAM des routeurs ne servent pas : on ne lit que les petits fichiers

const load = () => import('./gns3/gns3.js');

export default function Gns3Import({ onOpen }) {
  const fileInput = useRef(null);
  const dirInput = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  const run = async (task) => {
    setBusy(true);
    setError('');
    setResult(null);
    try {
      setResult(await task());
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const fromFile = (file) => run(async () => {
    const { readGns3 } = await load();
    return readGns3(new Uint8Array(await file.arrayBuffer()));
  });

  const fromDir = (list) => run(async () => {
    const { fromGns3 } = await load();
    const all = list;
    const full = (f) => f.webkitRelativePath || f.name;
    // Le .gns3 le moins profond donne le dossier du projet (on peut avoir choisi le dossier parent)
    const main = all.filter((f) => f.name.endsWith('.gns3')).sort((a, b) => full(a).split('/').length - full(b).split('/').length)[0];
    if (!main) throw new Error('Pas de fichier .gns3 dans ce dossier : choisis le dossier du projet (GNS3/projects/<nom du projet>).');
    const base = full(main).slice(0, full(main).length - main.name.length);
    const files = new Map(all
      .filter((f) => full(f).startsWith(`${base}project-files/`) && f.size <= MAX_FILE)
      .map((f) => [full(f).slice(base.length), async () => new Uint8Array(await f.arrayBuffer())]));
    return fromGns3(JSON.parse(await main.text()), files);
  });

  return (
    <>
      <p className="hint">
        Topologie, modèles (c3725, c3640, c7200 et leurs modules, MikroTik CHR, FRR), switch et VLAN, VPCS, câbles.
        Les configs des routeurs Cisco, des VPCS et des PC docker sont reprises si le projet les contient.
      </p>
      <div className="row">
        <button type="button" disabled={busy} onClick={() => fileInput.current?.click()}>Fichier .gns3project ou .gns3</button>
        <button type="button" className="ghost" disabled={busy} onClick={() => dirInput.current?.click()}>Dossier du projet</button>
      </div>
      <input ref={fileInput} type="file" accept=".gns3,.gns3project" hidden
        onChange={(e) => { if (e.target.files[0]) fromFile(e.target.files[0]); e.target.value = ''; }} />
      <input ref={dirInput} type="file" webkitdirectory="" hidden
        onChange={(e) => { if (e.target.files.length) fromDir([...e.target.files]); e.target.value = ''; }} />
      <p className="hint">Le dossier d'un projet est dans <code>GNS3/projects</code>. Le fichier .gns3 seul n'a pas les configs.</p>
      {busy && <p className="hint" role="status">Lecture du projet…</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {result && (
        <div className="gns3-result" data-testid="gns3-result">
          <p>
            <strong>{result.doc.name}</strong> : {result.doc.devices.length} équipement(s), {result.doc.links.length} câble(s),
            {' '}{result.configs} config(s) reprise(s).
          </p>
          {result.warnings.length > 0 && (
            <div className="notice export-warnings">
              <strong>{result.warnings.length} point(s) à vérifier</strong>
              <ul>{result.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </div>
          )}
          <button type="button" onClick={() => onOpen(result.doc)} disabled={!result.doc.devices.length}>Ouvrir dans NetCanvas</button>
        </div>
      )}
    </>
  );
}
