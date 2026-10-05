import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  ConnectionMode,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
} from '@xyflow/react';
import DeviceNode from './DeviceNode.jsx';
import CableEdge, { HOP_MS } from './CableEdge.jsx';
import SimPanel from './SimPanel.jsx';
// Chargés à la demande : l'éditeur s'ouvre plus vite
const ExportPanel = lazy(() => import('./ExportPanel.jsx'));
const Terminal = lazy(() => import('./Terminal.jsx'));
import { CableInspector, DeviceInspector, MultiInspector, Overview } from './Inspector.jsx';
import { arrange, copySelection, duplicate, search } from './editing.js';
import { DEVICE_TYPES, Icon, PALETTE, iconName } from './devices.jsx';
import Welcome from './Welcome.jsx';
import { desktop, openFile, saveFile, saveFileAs } from './files.js';
import { toJSON, fromJSON, freePorts, linksOfNode, deviceToData } from './serialize.js';
import { simulatePing } from './net/simulate.js';
import { traceroute } from './net/traceroute.js';
import { runService } from './net/services.js';
import { validate } from './net/validate.js';
import { HOST_TYPES, buildTopology } from './net/topology.js';
import { computeRouting } from './net/routing.js';
import { withLeases } from './net/dhcp.js';
import { EMPTY_RUNTIME, activeNat, formatTime } from './net/runtime.js';
import { mergeLearned } from './net/tables.js';
import TablesPanel from './TablesPanel.jsx';
import ConfigImport from './ConfigImport.jsx';
import ExercisePanel from './ExercisePanel.jsx';
import { evaluateExercise } from './net/exercise.js';
import { createShared, loadShared, myShares, parseShareLocation, rememberShare, saveShared, shareEnabled, shareLinks } from './share.js';
import { CABLES, MODELS, TYPES } from './net/catalog.js';
import { pickPorts } from './net/cabling.js';
import { EMPTY_SIM, LinkContext, SimContext } from './SimContext.js';

const STORAGE_KEY = 'netcanvas:draft';
const MODE_KEY = 'netcanvas:config-mode';
const HISTORY_MAX = 100;
const isTyping = (el) => el?.closest?.('input, textarea, select, [contenteditable="true"]');
const DND_TYPE = 'application/netcanvas';
const NODE_W = 96;
// Équipements qui ont un terminal (Internet et le hub n'en ont pas)
const hasTerminal = (d) => Boolean(d) && d.type !== 'cloud' && d.type !== 'hub';

const nodeTypes = Object.fromEntries(DEVICE_TYPES.map((t) => [t, DeviceNode]));
const CABLE_TOOLS = [['auto', 'Auto', 'Choisit le câble et les ports libres adaptés.'], ...Object.entries(CABLES).map(([id, c]) => [id, c.label, c.help])];
const edgeTypes = { cable: CableEdge };

const newId = () => crypto.randomUUID().slice(0, 8);
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function loadDoc(doc) {
  const loaded = fromJSON(doc);
  return { ...loaded, edges: loaded.edges.map((e) => ({ ...e, type: 'cable' })) };
}

function loadDraft() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? loadDoc(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function emptyData(model, count) {
  const type = MODELS[model].type;
  const data = { label: `${MODELS[model].vendor === 'mikrotik' ? 'MikroTik' : TYPES[type].label} ${count}`, model };
  if (HOST_TYPES.has(type)) Object.assign(data, { ip: '', mask: '', gateway: '' });
  if (type === 'router') Object.assign(data, { modules: {}, ifaces: {}, routes: [] });
  if (type === 'switch') data.ports = {};
  return data;
}

// Signature de la config (sans les positions) pour savoir si une simulation est périmée
const configSig = (doc) => JSON.stringify([doc.devices.map(({ position, ...d }) => d), doc.links]);
// Signature du document enregistrable (positions comprises, sans l'état d'exécution) : modifications non enregistrées
const fileSig = (doc) => JSON.stringify([doc.name, doc.devices, doc.links, doc.exercise ?? null]);
const VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '';
const EMPTY_DOC = { format: 'netcanvas', version: 3, name: 'Nouveau réseau', devices: [], links: [] };

// Bannière de mise à jour (application de bureau) : en tête de l'éditeur et dans l'écran d'accueil
function UpdateBanner({ update, onClose }) {
  return (
    <div className="update-banner" role="status">
      {update.state === 'downloading' && <>NetCanvas {update.version} est disponible : téléchargement en arrière-plan ({update.percent ?? 0} %).</>}
      {update.state === 'ready' && (<>
        NetCanvas {update.version} est prêt.
        <button type="button" className="small-btn" onClick={() => desktop.installUpdate()}>Redémarrer et mettre à jour</button>
        <span className="muted">(sinon, installé à la fermeture)</span>
      </>)}
      {update.state === 'manual' && (<>
        NetCanvas {update.version} est disponible.
        <button type="button" className="small-btn" onClick={() => desktop.installUpdate()}>Télécharger</button>
      </>)}
      <button type="button" className="ghost small-btn" onClick={onClose} aria-label="Masquer">✕</button>
    </div>
  );
}

function Editor() {
  // Brouillon enregistré automatiquement. Navigateur : rouvert tel quel. Application de bureau (fichiers) :
  // l'éditeur démarre vide, le brouillon n'est proposé qu'en récupération depuis l'accueil.
  const draft = useMemo(loadDraft, []);
  const start = desktop ? null : draft;
  const [nodes, setNodes, onNodesChange] = useNodesState(start?.nodes ?? []);
  const [edges, setEdges, onEdgesChange] = useEdgesState(start?.edges ?? []);
  const [name, setName] = useState(start?.name ?? 'Mon réseau');
  // État d'exécution : temps simulé, baux DHCP, table NAT (enregistré avec le schéma)
  const [runtime, setRuntime] = useState(() => ({ ...EMPTY_RUNTIME, ...start?.runtime }));
  // TP attaché au schéma : consigne et objectifs vérifiés en direct
  const [exercise, setExercise] = useState(start?.exercise ?? null);
  const [tab, setTab] = useState('props');
  const [cableTool, setCableTool] = useState('auto');
  const [configMode, setConfigModeState] = useState(() => {
    try {
      return localStorage.getItem(MODE_KEY) === 'terminal' ? 'terminal' : 'form';
    } catch {
      return 'form';
    }
  });
  const sessions = useRef(new Map()); // sessions des terminaux, par équipement
  const [error, setError] = useState('');
  // Fichier ouvert ({ name, path | handle }) et signature du document au dernier enregistrement
  const [file, setFile] = useState(null);
  const [savedSig, setSavedSig] = useState(null);
  const [cleanTick, setCleanTick] = useState(0);
  // Accueil au lancement, sauf lien de partage
  const [welcome, setWelcome] = useState(() => !parseShareLocation());
  const [recents, setRecents] = useState([]);
  // Mise à jour de l'application de bureau : { state: downloading | ready | manual | error, version, percent, url }
  const [update, setUpdate] = useState(null);
  const [simForm, setSimForm] = useState({ source: '', target: '', custom: '' });
  const [sim, setSim] = useState({ result: null, sig: null, playing: false, view: EMPTY_SIM });
  const { screenToFlowPosition, setCenter, fitView, setViewport } = useReactFlow();
  const wrapper = useRef(null);
  const timer = useRef(null);

  const doc = useMemo(() => toJSON(nodes, edges, name, runtime, exercise), [nodes, edges, name, runtime, exercise]);
  const sig = useMemo(() => fileSig(doc), [doc]);
  const dirty = savedSig !== sig && (Boolean(file) || doc.devices.length > 0);
  // Après ouverture ou enregistrement : le document affiché devient la référence « enregistrée »
  useEffect(() => {
    if (cleanTick) setSavedSig(sig);
  }, [cleanTick]); // eslint-disable-line react-hooks/exhaustive-deps
  const markClean = () => setCleanTick((t) => t + 1);
  useEffect(() => {
    document.title = `${dirty ? '• ' : ''}${file?.name ?? name} — NetCanvas`;
    desktop?.setDirty(dirty);
  }, [dirty, file, name]);
  // Document effectif (clients DHCP avec leur bail), topologie et routage : calculés une fois par modification
  const live = useMemo(() => withLeases(doc), [doc]);
  // Les baux calculés (renouvelés, expirés, d'hôtes partis) sont enregistrés dans l'état d'exécution
  useEffect(() => {
    const next = live.runtime?.leases ?? {};
    if (JSON.stringify(next) !== JSON.stringify(runtime.leases ?? {})) setRuntime((rt) => ({ ...rt, leases: next }));
  }, [live, runtime.leases]);
  const topo = useMemo(() => buildTopology(live), [live]);
  const routing = useMemo(() => computeRouting(live, topo), [live, topo]);
  const issues = useMemo(() => validate(live, { topo, routing }), [live, topo, routing]);
  // Objectifs du TP, revérifiés à chaque modification (pings simulés compris)
  const tpResults = useMemo(() => evaluateExercise(doc, { live, topo, routing, issues }), [doc, live, topo, routing, issues]);
  const linkStatus = topo.status;
  const labels = useMemo(() => new Map(nodes.map((n) => [n.id, n.data.label])), [nodes]);
  const selectedNodes = nodes.filter((n) => n.selected);
  const selected = selectedNodes.length === 1 ? selectedNodes[0] : null;
  const selectedEdge = selected ? null : edges.find((e) => e.selected);
  const selectedDevice = selected && doc.devices.find((d) => d.id === selected.id);
  const wideInspector = tab === 'props' && configMode === 'terminal' && hasTerminal(selectedDevice);
  const errorCount = issues.filter((i) => i.level === 'error').length;

  // --- Partage par lien ----------------------------------------------------------
  // shared : { id, token (édition) | null (lecture seule), embed, status: loading|saved|saving|error, savedAt, message }
  const [shared, setShared] = useState(() => {
    const loc = parseShareLocation();
    return loc ? { ...loc, status: 'loading' } : null;
  });
  const readOnly = Boolean(shared && !shared.token);
  const lastSaved = useRef(null); // dernier document enregistré en ligne
  const shareDialog = useRef(null);

  // Sauvegarde automatique : brouillon local, sauf pendant qu'un schéma partagé est ouvert
  useEffect(() => {
    if (shared) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(doc));
    } catch {
      /* stockage indisponible : on ignore */
    }
  }, [doc, shared]);

  // Ouverture d'un lien ?d=…
  useEffect(() => {
    if (shared?.status !== 'loading') return;
    loadShared(shared.id)
      .then((row) => {
        if (!row) throw new Error('Ce lien de partage n\'existe pas (ou plus).');
        replaceDoc(loadDoc(row.doc));
        lastSaved.current = null; // fixé au premier rendu du document chargé
        setShared((s) => ({ ...s, status: 'saved', savedAt: row.updatedAt }));
        if (shared.token) rememberShare({ id: shared.id, token: shared.token, name: row.name, at: row.updatedAt });
      })
      .catch((err) => {
        setError(`Partage : ${err.message}`);
        setShared(null);
        window.history.replaceState(null, '', '/');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shared?.status]);

  // Lien d'édition : enregistrement en ligne une seconde après la dernière modification
  useEffect(() => {
    if (!shared?.token || shared.status === 'loading') return undefined;
    const snap = JSON.stringify(doc);
    if (lastSaved.current === null) {
      lastSaved.current = snap;
      return undefined;
    }
    if (snap === lastSaved.current) return undefined;
    const t = setTimeout(() => {
      setShared((s) => ({ ...s, status: 'saving' }));
      saveShared(shared.id, shared.token, doc)
        .then((at) => {
          lastSaved.current = snap;
          setShared((s) => ({ ...s, status: 'saved', savedAt: at, message: null }));
          rememberShare({ id: shared.id, token: shared.token, name: doc.name, at });
        })
        .catch((err) => setShared((s) => ({ ...s, status: 'error', message: err.message })));
    }, 1000);
    return () => clearTimeout(t);
  }, [doc, shared?.token, shared?.status === 'loading']);

  const share = async () => {
    if (shared?.token) {
      shareDialog.current?.showModal();
      return;
    }
    try {
      setShared({ id: null, token: null, status: 'saving' });
      const { id, token } = await createShared(doc);
      window.history.replaceState(null, '', `/?d=${id}#edit=${token}`);
      lastSaved.current = JSON.stringify(doc);
      const at = new Date().toISOString();
      setShared({ id, token, embed: false, status: 'saved', savedAt: at });
      rememberShare({ id, token, name: doc.name, at });
      shareDialog.current?.showModal();
    } catch (err) {
      setShared(null);
      setError(`Partage impossible : ${err.message}`);
    }
  };

  // Quitter le schéma partagé : retour au brouillon local (« garder » : le schéma devient le brouillon)
  // restore : recharger le brouillon (sinon l'appelant charge autre chose)
  const leaveShared = (keep, restore = true) => {
    if (keep && draft?.nodes.length && !confirm('Remplacer ton brouillon local par ce schéma ?')) return;
    window.history.replaceState(null, '', window.location.pathname);
    setShared(null);
    if (!keep && restore) {
      const local = loadDraft();
      replaceDoc(local ?? { nodes: [], edges: [], name: 'Mon réseau', runtime: null });
    }
  };

  useEffect(() => () => clearTimeout(timer.current), []);

  // --- Annuler / rétablir ------------------------------------------------------
  // On garde des instantanés du document ; les modifications rapprochées (frappe, glisser) n'en font qu'un.
  const history = useRef({ past: [], future: [], last: null, restoring: false });
  const [historyTick, setHistoryTick] = useState(0);
  useEffect(() => {
    const h = history.current;
    const snap = JSON.stringify(doc);
    if (h.restoring || h.last === null) {
      h.restoring = false;
      h.last = snap;
      return undefined;
    }
    if (snap === h.last) return undefined;
    const t = setTimeout(() => {
      h.past = [...h.past, h.last].slice(-HISTORY_MAX);
      h.future = [];
      h.last = snap;
      setHistoryTick((x) => x + 1);
    }, 400);
    return () => clearTimeout(t);
  }, [doc]);

  const restore = (snap) => {
    const keep = new Set(nodes.filter((n) => n.selected).map((n) => n.id));
    const loaded = loadDoc(JSON.parse(snap));
    history.current.restoring = true;
    resetSim();
    setNodes(loaded.nodes.map((n) => ({ ...n, selected: keep.has(n.id) })));
    setEdges(loaded.edges);
    setName(loaded.name ?? 'Mon réseau');
    setRuntime({ ...EMPTY_RUNTIME, ...loaded.runtime });
    setExercise(loaded.exercise ?? null);
  };

  const undo = () => {
    const h = history.current;
    const now = JSON.stringify(doc);
    if (now !== h.last) h.past = [...h.past, h.last]; // modification pas encore enregistrée
    if (!h.past.length) return;
    h.future = [...h.future, now];
    h.last = h.past.at(-1);
    h.past = h.past.slice(0, -1);
    restore(h.last);
    setHistoryTick((x) => x + 1);
  };

  const redo = () => {
    const h = history.current;
    if (!h.future.length) return;
    h.past = [...h.past, JSON.stringify(doc)];
    h.last = h.future.at(-1);
    h.future = h.future.slice(0, -1);
    restore(h.last);
    setHistoryTick((x) => x + 1);
  };
  const canUndo = historyTick >= 0 && (history.current.past.length > 0 || (history.current.last !== null && JSON.stringify(doc) !== history.current.last));
  const canRedo = historyTick >= 0 && history.current.future.length > 0;

  // --- Copier / coller / dupliquer ---------------------------------------------------
  const clipboard = useRef(null);
  const pasteCount = useRef(0);
  const copy = () => {
    if (!nodes.some((n) => n.selected)) return;
    clipboard.current = copySelection(nodes, edges);
    pasteCount.current = 0;
  };
  const paste = (clip = clipboard.current) => {
    if (!clip?.nodes.length) return;
    pasteCount.current += 1;
    const added = duplicate(clip, nodes, 32 * pasteCount.current);
    setNodes((nds) => [...nds.map((n) => ({ ...n, selected: false })), ...added.nodes]);
    setEdges((eds) => [...eds.map((e) => ({ ...e, selected: false })), ...added.edges]);
  };
  const duplicateSelection = () => {
    if (!nodes.some((n) => n.selected)) return;
    pasteCount.current = 0;
    paste(copySelection(nodes, edges));
  };

  const deleteSelection = () => {
    const ids = new Set(nodes.filter((n) => n.selected).map((n) => n.id));
    setNodes((nds) => nds.filter((n) => !ids.has(n.id)));
    setEdges((eds) => eds.filter((e) => !ids.has(e.source) && !ids.has(e.target)));
  };

  // --- Recherche --------------------------------------------------------------------
  const [query, setQuery] = useState('');
  const searchInput = useRef(null);
  const results = useMemo(() => search(doc, query), [doc, query]);
  const helpDialog = useRef(null);

  // Nouveau câble : on choisit les ports libres et le câble selon l'outil sélectionné (comme Packet Tracer)
  const onConnect = useCallback(
    (params) => {
      if (params.source === params.target) return;
      const [a, b] = [nodes.find((n) => n.id === params.source), nodes.find((n) => n.id === params.target)];
      const side = (n) => ({ label: n.data.label, type: n.type, free: freePorts(n, edges) });
      const pick = pickPorts(side(a), side(b), cableTool);
      if (pick.error) {
        setError(pick.error);
        return;
      }
      setError('');
      const id = `link-${newId()}`;
      const data = {
        cable: pick.cable,
        sourceIface: pick.portA.name,
        targetIface: pick.portB.name,
        ...(pick.cable === 'serial' ? { dce: 'source' } : {}),
      };
      setEdges((eds) => addEdge({ ...params, id, type: 'cable', data }, eds));
    },
    [nodes, edges, cableTool, setEdges, setNodes],
  );

  const addDevice = useCallback(
    (model, position) => {
      const type = MODELS[model].type;
      setNodes((nds) => {
        // Décale l'équipement tant qu'il recouvre un équipement existant
        const pos = { ...position };
        while (nds.some((n) => Math.abs(n.position.x - pos.x) < NODE_W && Math.abs(n.position.y - pos.y) < 80)) {
          pos.x += 32;
          pos.y += 32;
        }
        const count = nds.filter((n) => n.type === type).length + 1;
        return [
          ...nds.map((n) => ({ ...n, selected: false })),
          { id: `${type}-${newId()}`, type, position: pos, selected: true, data: emptyData(model, count) },
        ];
      });
      setTab('props');
    },
    [setNodes],
  );

  const onDrop = useCallback(
    (e) => {
      e.preventDefault();
      const model = e.dataTransfer.getData(DND_TYPE);
      if (!MODELS[model]) return;
      // On centre l'icône sous le curseur
      const p = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      addDevice(model, { x: p.x - NODE_W / 2, y: p.y - 40 });
    },
    [screenToFlowPosition, addDevice],
  );

  // Alternative clavier / clic au glisser-déposer : ajout au centre de la vue
  const addAtCenter = (model) => {
    const r = wrapper.current.getBoundingClientRect();
    const p = screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    addDevice(model, { x: p.x - NODE_W / 2, y: p.y - 40 });
  };

  const updateNode = (id) => (fn) => setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data: fn(n.data) } : n)));
  const updateEdge = (id) => (fn) => setEdges((eds) => eds.map((e) => (e.id === id ? { ...e, data: fn(e.data ?? {}) } : e)));

  // La config reste sur le port quand on débranche, comme sur le vrai matériel
  const deleteEdge = (id) => setEdges((eds) => eds.filter((e) => e.id !== id));

  const selectNode = (id) => {
    const node = nodes.find((n) => n.id === id);
    if (!node) return;
    setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === id })));
    setCenter(node.position.x + NODE_W / 2, node.position.y + 40, { zoom: 1.2, duration: reducedMotion() ? 0 : 300 });
    setTab('props');
  };

  const deleteSelected = () => {
    const removed = new Set(linksOfNode(edges, selected.id).map((e) => e.id));
    setNodes((nds) => nds.filter((n) => n.id !== selected.id));
    setEdges((eds) => eds.filter((e) => !removed.has(e.id)));
  };

  // Raccourcis clavier (hors champs de saisie : là, Ctrl+Z reste celui du navigateur)
  const shortcuts = useRef({});
  shortcuts.current = {
    readOnly,
    undo, redo, copy, paste, duplicateSelection,
    hasSelection: () => nodes.some((n) => n.selected),
    hasClipboard: () => Boolean(clipboard.current?.nodes.length),
  };
  useEffect(() => {
    const onKey = (e) => {
      if (isTyping(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (shortcuts.current.readOnly && mod && ['z', 'y', 'v', 'd'].includes(k)) return; // lecture seule
      const run = (fn) => {
        e.preventDefault();
        shortcuts.current[fn]();
      };
      if (mod && k === 'z' && !e.shiftKey) run('undo');
      else if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) run('redo');
      // Ctrl+C / Ctrl+V : seulement s'il y a des équipements, sinon copie de texte normale
      else if (mod && k === 'c' && window.getSelection()?.isCollapsed !== false && shortcuts.current.hasSelection()) run('copy');
      else if (mod && k === 'v' && shortcuts.current.hasClipboard()) run('paste');
      else if (mod && k === 'd') run('duplicateSelection');
      else if ((mod && k === 'k') || (!mod && e.key === '/')) {
        e.preventDefault();
        searchInput.current?.focus();
      } else if (!mod && e.key === '?') {
        e.preventDefault();
        helpDialog.current?.showModal();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // --- Simulation ------------------------------------------------------------
  const stopSim = () => clearTimeout(timer.current);

  function play(result) {
    stopSim();
    const { hops } = result;
    const finalView = {
      hop: null,
      edges: new Map(hops.map((h) => [h.edge, h.phase])),
      nodes: new Set(hops.flatMap((h) => [h.from, h.to])),
      failedAt: result.failedAt,
    };
    if (reducedMotion() || !hops.length) {
      setSim((s) => ({ ...s, playing: false, view: finalView }));
      return;
    }
    const step = (i) => {
      if (i === hops.length) {
        setSim((s) => ({ ...s, playing: false, view: finalView }));
        return;
      }
      const done = hops.slice(0, i);
      setSim((s) => ({
        ...s,
        playing: true,
        view: {
          hop: { ...hops[i], key: i },
          edges: new Map(done.map((h) => [h.edge, h.phase])),
          nodes: new Set([hops[0].from, ...done.map((h) => h.to)]),
          failedAt: null,
        },
      }));
      timer.current = setTimeout(() => step(i + 1), HOP_MS);
    };
    step(0);
  }

  const setConfigMode = (mode) => {
    setConfigModeState(mode);
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      /* stockage indisponible : on ignore */
    }
  };

  // Les traductions NAT d'un ping entrent dans la table persistante (elles expirent avec le temps)
  // … de même que ce qu'il a appris : caches ARP, tables MAC des switches
  const keepNat = (result) => {
    setRuntime((rt) => mergeLearned({ ...rt, nat: [...activeNat(rt), ...(result.natAdded ?? [])] }, result.learned, live));
  };

  // Un ping tapé dans un terminal s'anime aussi sur le plan
  const pingFromTerminal = (src, dst, options = {}) => {
    const result = simulatePing(live, src, dst, { topo, routing, ...options });
    keepNat(result);
    setSim({ result, sig: configSig(doc), playing: false, view: EMPTY_SIM });
    play(result);
  };

  // Ping ou traceroute (la trace réutilise l'animation du ping)
  // mode : 'ping' | 'trace' | 'dns' | 'web' ; stepwise : pas à pas
  const runSim = (src, dst, mode = 'ping', stepwise = false) => {
    const service = mode === 'dns' || mode === 'web';
    const result = service ? runService(live, src, mode, dst, { topo, routing }) : simulatePing(live, src, dst, { topo, routing });
    keepNat(result);
    if (mode === 'trace') result.trace = traceroute(live, src, dst);
    setSim({ result, sig: configSig(doc), playing: false, view: EMPTY_SIM, step: null });
    if (stepwise && result.frames?.length) showFrame(result, 0);
    else play(result);
  };

  // Pas à pas : trame i affichée sur le plan (câbles allumés ensemble, déjà parcourus en couleur)
  const kindClass = (f) => (f.kind.startsWith('arp') || f.kind.startsWith('nd-') ? 'arp' : f.phase);
  const showFrame = (result, i) => {
    stopSim();
    const frames = result.frames ?? [];
    const frame = frames[i];
    if (!frame) return;
    const before = frames.slice(0, i);
    setSim((s) => ({
      ...s,
      result,
      step: i,
      playing: false,
      view: {
        hop: null,
        hops: frame.hops.map((h, k) => ({ ...h, phase: kindClass(frame), key: `${i}-${k}` })),
        edges: new Map(before.filter((f) => ['icmp', 'udp', 'tcp'].includes(f.kind)).flatMap((f) => f.hops.map((h) => [h.edge, f.phase]))),
        nodes: new Set([...before, frame].flatMap((f) => f.hops.flatMap((h) => [h.from, h.to]))),
        failedAt: frame.kind === 'drop' ? result.failedAt : null,
      },
    }));
  };

  const resetSim = () => {
    stopSim();
    setSim({ result: null, sig: null, playing: false, view: EMPTY_SIM });
  };

  // --- Fichiers ----------------------------------------------------------------
  const replaceDoc = (loaded) => {
    resetSim();
    setNodes(loaded.nodes);
    setEdges(loaded.edges);
    setName(loaded.name ?? 'Mon réseau');
    setRuntime({ ...EMPTY_RUNTIME, ...loaded.runtime });
    setExercise(loaded.exercise ?? null);
    setError('');
    if (loaded.nodes.length) requestAnimationFrame(() => fitView({ maxZoom: 1, duration: reducedMotion() ? 0 : 300 }));
    else setViewport({ x: 0, y: 0, zoom: 1 });
  };

  // --- Fichiers : nouveau, ouvrir, enregistrer --------------------------------------------
  const fileMenu = useRef(null);
  const closeMenu = () => { if (fileMenu.current) fileMenu.current.open = false; };
  const discardOk = () => !dirty || confirm('Le schéma a des modifications non enregistrées. Les abandonner ?');
  const startFrom = (loaded, f = null) => {
    if (shared) leaveShared(false, false);
    replaceDoc(loaded);
    setFile(f);
    markClean();
    setWelcome(false);
  };
  const newProject = () => {
    closeMenu();
    if (!discardOk()) return;
    startFrom(loadDoc(EMPTY_DOC));
  };
  const openContent = (content, f) => {
    try {
      startFrom(loadDoc(JSON.parse(content)), f);
      if (f?.path) desktop?.addRecent(f.path).then(setRecents);
    } catch (err) {
      setError(err instanceof SyntaxError ? `${f?.name ?? 'Ce fichier'} n'est pas un schéma NetCanvas (JSON invalide).` : err.message);
    }
  };
  const openProject = async () => {
    closeMenu();
    if (!discardOk()) return;
    try {
      const r = await openFile();
      if (r) openContent(r.content, r.file);
    } catch (err) {
      setError(`Ouverture impossible : ${err.message}`);
    }
  };
  const openPath = async (path) => {
    if (!discardOk()) return;
    try {
      const r = await desktop.readFile(path);
      openContent(r.content, { name: r.name, path: r.path });
    } catch (err) {
      setError(`Ouverture impossible : ${err.message}`);
      desktop.recentFiles().then(setRecents);
    }
  };
  const saveProject = async (as = false) => {
    closeMenu();
    try {
      const f = as ? await saveFileAs(doc) : await saveFile(doc, file);
      if (!f) return false;
      setFile(f.downloaded ? null : f);
      markClean();
      if (f.path) desktop?.addRecent(f.path).then(setRecents);
      return true;
    } catch (err) {
      setError(`Enregistrement impossible : ${err.message}`);
      return false;
    }
  };
  const openExample = (demo) => {
    closeMenu();
    if (!discardOk()) return;
    startFrom(loadDoc(demo.doc));
  };

  // Application de bureau : menus natifs, fichier ouvert par double-clic, fermeture avec modifications
  const fileActions = useRef({});
  fileActions.current = { newProject, openProject, saveProject, openPath, showWelcome: () => setWelcome(true), dirty };
  useEffect(() => {
    if (!desktop) return undefined;
    desktop.recentFiles().then(setRecents);
    const offMenu = desktop.onMenu(async (cmd) => {
      const a = fileActions.current;
      if (cmd === 'new') a.newProject();
      else if (cmd === 'open') a.openProject();
      else if (cmd === 'save') a.saveProject(false);
      else if (cmd === 'save-as') a.saveProject(true);
      else if (cmd === 'welcome') a.showWelcome();
      else if (cmd === 'save-and-close') { if (await a.saveProject(false)) desktop.closeNow(); }
    });
    const offOpen = desktop.onOpenPath((path) => fileActions.current.openPath(path));
    const offUpdate = desktop.onUpdate((u) => setUpdate((cur) => (u.state === 'error' ? null : { ...cur, ...u })));
    desktop.ready();
    return () => { offMenu(); offOpen(); offUpdate(); };
  }, []);
  // Navigateur : Ctrl+O, Ctrl+S, Ctrl+Maj+S (l'application de bureau passe par ses menus)
  useEffect(() => {
    if (desktop) return undefined;
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === 's') { e.preventDefault(); fileActions.current.saveProject(e.shiftKey); }
      else if (k === 'o') { e.preventDefault(); fileActions.current.openProject(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const TABS = [
    ['props', 'Propriétés', errorCount ? errorCount : null, `${errorCount} erreur(s)`],
    ['sim', 'Simulation'],
    ['tables', 'Tables'],
    ['tp', 'TP', exercise && tpResults.length ? `${tpResults.filter((r) => r.ok).length}/${tpResults.length}` : null, 'objectifs atteints'],
    ['export', 'Export'],
  ];

  return (
    <LinkContext.Provider value={linkStatus}>
      <SimContext.Provider value={sim.view}>
        <div className={`app${wideInspector ? ' wide-inspector' : ''}${readOnly ? ' read-only' : ''}${shared?.embed ? ' embed' : ''}`}>
          <header className="topbar">
            <div className="brand">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="5" cy="6" r="2.5" /><circle cx="19" cy="6" r="2.5" /><circle cx="12" cy="18" r="2.5" />
                <path d="M7.5 6h9M6.3 8.2l4.4 7.6M17.7 8.2l-4.4 7.6" />
              </svg>
              NetCanvas
            </div>
            <label className="visually-hidden" htmlFor="name">Nom du schéma</label>
            <input id="name" className="doc-name" value={name} readOnly={readOnly} onChange={(e) => setName(e.target.value)} />
            <div className="actions">
              <div className="clock" role="group" aria-label="Temps simulé">
                <span className="clock-time" title="Temps simulé (baux DHCP, table NAT)">⏱ {formatTime(runtime.time)}</span>
                {[[60, '+1 min'], [3600, '+1 h'], [86400, '+1 j']].map(([dt, label]) => (
                  <button key={dt} type="button" className="ghost small-btn" onClick={() => setRuntime((rt) => ({ ...rt, time: rt.time + dt }))}>{label}</button>
                ))}
                <button type="button" className="ghost small-btn" disabled={!runtime.time && !runtime.nat.length && !Object.keys(runtime.leases).length}
                  aria-label="Remettre le temps à zéro (vide les baux et la table NAT)" title="Remettre à zéro : temps, baux DHCP, table NAT"
                  onClick={() => setRuntime({ ...EMPTY_RUNTIME })}>↺</button>
              </div>
              {!readOnly && (<>
              <details className="demo-menu" ref={fileMenu}>
                <summary className="button ghost">Fichier</summary>
                <div className="demo-list" role="menu">
                  <button type="button" role="menuitem" onClick={newProject}>Nouveau</button>
                  <button type="button" role="menuitem" onClick={openProject}>Ouvrir… <kbd>Ctrl+O</kbd></button>
                  <button type="button" role="menuitem" onClick={() => saveProject(false)}>Enregistrer <kbd>Ctrl+S</kbd></button>
                  <button type="button" role="menuitem" onClick={() => saveProject(true)}>Enregistrer sous… <kbd>Ctrl+Maj+S</kbd></button>
                  <button type="button" role="menuitem" onClick={() => { closeMenu(); setWelcome(true); }}>Accueil et exemples</button>
                </div>
              </details>
              <div className="icon-group" role="group" aria-label="Historique">
                <button type="button" className="ghost icon" onClick={undo} disabled={!canUndo} aria-label="Annuler (Ctrl+Z)" title="Annuler (Ctrl+Z)">↶</button>
                <button type="button" className="ghost icon" onClick={redo} disabled={!canRedo} aria-label="Rétablir (Ctrl+Y)" title="Rétablir (Ctrl+Y)">↷</button>
              </div>
              </>)}
              <button type="button" className="ghost icon" onClick={() => helpDialog.current?.showModal()} aria-label="Raccourcis clavier" title="Raccourcis clavier (?)">?</button>
              {shareEnabled && !readOnly && (
                <button type="button" className="ghost" onClick={share} disabled={shared?.status === 'saving' && !shared.id}>
                  {shared?.token ? 'Partagé' : 'Partager'}
                </button>
              )}
              <button type="button" onClick={() => setTab('export')}>Exporter</button>
            </div>
          </header>
          <div className="notices">
          {error && <p className="error" role="alert">{error}</p>}
          {update && <UpdateBanner update={update} onClose={() => setUpdate(null)} />}
          {shared && !shared.embed && (
            <div className={`share-banner${readOnly ? ' ro' : ''}`} role="status">
              {shared.status === 'loading' ? 'Ouverture du schéma partagé…'
                : readOnly ? <>Schéma partagé en <strong>lecture seule</strong> : tu peux le parcourir et simuler des pings.</>
                  : shared.status === 'error' ? <span className="field-error">Enregistrement en ligne impossible : {shared.message}</span>
                    : shared.status === 'saving' ? 'Enregistrement en ligne…'
                      : <>Schéma partagé, enregistré en ligne{shared.savedAt ? ` à ${new Date(shared.savedAt).toLocaleTimeString('fr-FR')}` : ''}.</>}
              <span className="share-actions">
                {readOnly ? (
                  <button type="button" className="ghost small-btn" onClick={() => leaveShared(true)}>Dupliquer pour modifier</button>
                ) : shared.token && (
                  <button type="button" className="ghost small-btn" onClick={() => shareDialog.current?.showModal()}>Liens</button>
                )}
                {shared.status !== 'loading' && (
                  <button type="button" className="ghost small-btn" onClick={() => leaveShared(false)}>Retour à mon brouillon</button>
                )}
              </span>
            </div>
          )}
          </div>

          <aside className="palette" aria-label="Équipements" inert={readOnly ? '' : undefined}>
            <div className="search">
              <label className="visually-hidden" htmlFor="search">Rechercher un équipement</label>
              <input id="search" ref={searchInput} type="search" placeholder="Rechercher (nom, IP)…  Ctrl+K" value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && results[0]) {
                    selectNode(results[0].id);
                    setQuery('');
                  } else if (e.key === 'Escape') setQuery('');
                }} />
              {query && (
                <ul className="search-results" role="listbox" aria-label="Résultats">
                  {results.length ? results.map((r) => (
                    <li key={r.id}>
                      <button type="button" role="option" aria-selected="false" onClick={() => { selectNode(r.id); setQuery(''); }}>
                        {r.label} <span className="muted">{r.detail}</span>
                      </button>
                    </li>
                  )) : <li className="muted">Aucun équipement</li>}
                </ul>
              )}
            </div>
            <h2>Équipements</h2>
            <p className="hint">Glisse sur le plan, ou clique pour ajouter.</p>
            {PALETTE.map((group) => (
              <details key={group.title} className="palette-group" open>
                <summary>{group.title}</summary>
                {group.models.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className="palette-item"
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(DND_TYPE, m.id);
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onClick={() => addAtCenter(m.id)}
                  >
                    <span className={`palette-icon device-${m.type}`}><Icon name={iconName(m.type, m.id)} /></span>
                    {m.label}
                  </button>
                ))}
              </details>
            ))}
            <details className="palette-group" open>
              <summary>Câbles</summary>
              <div className="cable-tools" role="radiogroup" aria-label="Câble pour la prochaine liaison">
                {CABLE_TOOLS.map(([id, label]) => (
                  <button key={id} type="button" role="radio" aria-checked={cableTool === id}
                    className={`cable-tool cable-tool-${id}`} onClick={() => setCableTool(id)}>
                    <span className="cable-swatch" aria-hidden="true" />{label}
                  </button>
                ))}
              </div>
              <p className="hint">{CABLE_TOOLS.find(([id]) => id === cableTool)[2]}{cableTool === 'serial' ? ' Le premier équipement relié est le côté DCE.' : ''}</p>
            </details>
            <p className="hint">Relie deux équipements en tirant depuis un point bleu. Suppr pour effacer la sélection.</p>
          </aside>

          <main className="canvas" ref={wrapper} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={readOnly ? undefined : onConnect}
              connectionMode={ConnectionMode.Loose}
              nodesDraggable={!readOnly}
              nodesConnectable={!readOnly}
              deleteKeyCode={readOnly ? null : ['Delete', 'Backspace']}
              multiSelectionKeyCode={['Control', 'Meta', 'Shift']}
              colorMode="system"
              snapToGrid
              snapGrid={[16, 16]}
              // Recadrage seulement à l'ouverture d'un brouillon, sinon le 1er équipement déposé déclenche un zoom x2
              fitView={Boolean(start?.nodes.length)}
              fitViewOptions={{ maxZoom: 1 }}
              defaultViewport={{ x: 0, y: 0, zoom: 1 }}
            >
              <Background gap={16} />
              <Controls />
              <MiniMap pannable zoomable />
            </ReactFlow>
            {nodes.length === 0 && (
              <div className="empty">
                <p>Glisse un routeur, un switch ou un PC ici pour commencer.</p>
                <button type="button" className="ghost" onClick={() => setWelcome(true)}>Voir les exemples</button>
              </div>
            )}
          </main>

          <aside className="inspector" aria-label="Panneau latéral">
            <div className="tabs" role="tablist">
              {TABS.map(([key, label, badge, badgeLabel]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  id={`tab-${key}`}
                  aria-selected={tab === key}
                  aria-controls="panel"
                  className="tab"
                  onClick={() => setTab(key)}
                >
                  {label}
                  {badge && <span className={`badge${key === 'tp' ? ' badge-tp' : ''}`} aria-label={`${badge} ${badgeLabel}`}>{badge}</span>}
                </button>
              ))}
            </div>
            <div id="panel" role="tabpanel" aria-labelledby={`tab-${tab}`} className="panel">
              {tab === 'props' && (
                <fieldset className="ro-fieldset" disabled={readOnly}>
                {selected ? (
                <DeviceInspector key={selected.id} node={selected} edges={edges} labels={labels}
                  update={updateNode(selected.id)} onDelete={deleteSelected} mode={configMode} onMode={setConfigMode}
                  routing={routing.routers.get(selected.id)} issues={issues.filter((i) => i.device === selected.id)}
                  live={live.devices.find((d) => d.id === selected.id)?.config}
                  live6={new Map(topo.l3Ifaces6(selected.id, { includeDown: true }).map((i) => [i.name, i]))}
                  importer={!readOnly && (selected.type === 'router' || selected.type === 'switch') && (
                    <ConfigImport device={selectedDevice} doc={doc} onApply={(dev) => updateNode(selected.id)(() => deviceToData(dev, doc.links))} />
                  )}
                  terminal={hasTerminal(selectedDevice) && (
                    <Suspense fallback={<p className="hint">Chargement du terminal…</p>}>
                      <Terminal key={selected.id} device={selectedDevice} doc={doc} sessions={sessions.current}
                        onChange={(dev) => updateNode(selected.id)(() => deviceToData(dev, doc.links))} onPing={pingFromTerminal} onRuntime={(update) => setRuntime(update)} />
                    </Suspense>
                  )} />
              ) : selectedNodes.length > 1 ? (
                <MultiInspector nodes={selectedNodes}
                  onArrange={(how) => setNodes((nds) => arrange(nds, how))}
                  onDuplicate={duplicateSelection} onDelete={deleteSelection} />
              ) : selectedEdge ? (
                <CableInspector key={selectedEdge.id} edge={selectedEdge} nodes={nodes} edges={edges}
                  updateEdge={updateEdge(selectedEdge.id)} updateNode={updateNode} onDelete={() => deleteEdge(selectedEdge.id)} />
              ) : (
                <Overview nodes={nodes} edges={edges} issues={issues} onSelect={selectNode} />
              )}
                </fieldset>
              )}
              {tab === 'tp' && (
                <ExercisePanel exercise={exercise} results={tpResults} devices={live.devices} doc={live} readOnly={readOnly}
                  onChange={setExercise} onLocate={selectNode} />
              )}
              {tab === 'tables' && (
                <TablesPanel device={selected ? live.devices.find((d) => d.id === selected.id) : null} doc={live} routing={routing}
                  labels={labels} readOnly={readOnly} onRuntime={(update) => setRuntime(update)} />
              )}
              {tab === 'sim' && (
                <>
                  {sim.result && sim.sig !== configSig(doc) && (
                    <p className="notice">Le schéma a changé depuis cette simulation. Relance-la.</p>
                  )}
                  <SimPanel doc={live} form={simForm} setForm={setSimForm} result={sim.result} playing={sim.playing}
                    onRun={runSim} onReplay={() => { setSim((s) => ({ ...s, step: null })); play(sim.result); }} onReset={resetSim}
                    step={sim.step ?? null} onStep={(i) => showFrame(sim.result, i)} labels={labels} />
                </>
              )}
              {tab === 'export' && (
                <Suspense fallback={<p className="hint">Chargement…</p>}>
                  <ExportPanel doc={doc} />
                </Suspense>
              )}
            </div>
          </aside>
          <dialog ref={shareDialog} className="help-dialog share-dialog" aria-labelledby="share-title">
            <h2 id="share-title">Partager ce schéma</h2>
            {shared?.id && shared.token && (() => {
              const links = shareLinks(shared.id, shared.token);
              return (
                <>
                  {[['Lecture seule (élèves, collègues)', links.view], ['Édition (garde-le pour toi)', links.edit], ['Intégration (iframe, Moodle, Notion)', `<iframe src="${links.embed}" width="100%" height="600"></iframe>`]].map(([label, url]) => (
                    <div className="field" key={label}>
                      <label>{label}</label>
                      <div className="copy-row">
                        <input readOnly value={url} onFocus={(e) => e.target.select()} />
                        <button type="button" className="ghost small-btn" onClick={() => navigator.clipboard?.writeText(url)}>Copier</button>
                      </div>
                    </div>
                  ))}
                  <p className="hint">Le lien d'édition contient une clé secrète : toute personne qui l'a peut modifier le schéma. Il est aussi gardé dans ce navigateur, dans « Mes partages ».</p>
                </>
              );
            })()}
            {myShares().length > 1 && (
              <>
                <h3>Mes partages</h3>
                <ul className="my-shares">
                  {myShares().slice(0, 10).map((m) => (
                    <li key={m.id}><a href={shareLinks(m.id, m.token).edit}>{m.name || m.id}</a> <span className="muted">{m.at ? new Date(m.at).toLocaleString('fr-FR') : ''}</span></li>
                  ))}
                </ul>
              </>
            )}
            <form method="dialog"><button type="submit">Fermer</button></form>
          </dialog>
          <dialog ref={helpDialog} className="help-dialog" aria-labelledby="help-title">
            <h2 id="help-title">Raccourcis clavier</h2>
            <dl className="shortcuts">
              {[
                ['Ctrl+Z', 'Annuler'], ['Ctrl+Y ou Ctrl+Maj+Z', 'Rétablir'],
                ['Ctrl+C / Ctrl+V', 'Copier / coller la sélection'], ['Ctrl+D', 'Dupliquer la sélection'],
                ['Suppr', 'Supprimer la sélection'], ['Maj + glisser', 'Sélection par rectangle'],
                ['Ctrl/Maj + clic', 'Ajouter à la sélection'], ['Ctrl+K ou /', 'Rechercher un équipement'],
                ['?', 'Cette aide'],
              ].map(([k, v]) => (
                <div key={k}><dt><kbd>{k}</kbd></dt><dd>{v}</dd></div>
              ))}
            </dl>
            <p className="hint">Dans le terminal, Ctrl+Z sort du mode configuration (IOS).</p>
            <form method="dialog"><button type="submit">Fermer</button></form>
          </dialog>
          {welcome && (
            <Welcome version={VERSION} recents={recents}
              draft={draft?.nodes.length && !file && !(desktop && nodes.length) ? { name: draft.name ?? 'Mon réseau', count: draft.nodes.length, recover: Boolean(desktop) } : null}
              onNew={newProject} onOpen={openProject} onRecent={(r) => openPath(r.path)}
              onResume={() => {
                // Bureau : on recharge le brouillon (non enregistré, donc marqué modifié)
                if (desktop) replaceDoc(draft);
                setWelcome(false);
              }}
              onExample={openExample} onClose={() => setWelcome(false)}
              notice={update && <UpdateBanner update={update} onClose={() => setUpdate(null)} />} />
          )}
        </div>
      </SimContext.Provider>
    </LinkContext.Provider>
  );
}

export default function App() {
  return (
    <ReactFlowProvider>
      <Editor />
    </ReactFlowProvider>
  );
}
