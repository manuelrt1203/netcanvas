// Formulaires ACL / NAT (Cisco) et pare-feu / NAT (MikroTik). Même configuration que les terminaux.
import { useId, useState } from 'react';
import { aclTypeOf, firewallRuleText, parseAclLine, parseFirewallRule, ruleText } from './net/acl.js';
import { isValidIp } from './net/ip.js';
import { isMikrotik } from './net/catalog.js';

// Zone de texte « une règle par ligne » : on garde le texte tapé, la config n'est mise à jour
// que quand toutes les lignes sont valides ; sinon les erreurs s'affichent ligne par ligne.
function RulesEditor({ label, lines, parse, onValid, placeholder }) {
  const id = useId();
  const [text, setText] = useState(lines.join('\n'));
  const results = text.split('\n').map((l, i) => ({ n: i + 1, line: l, r: l.trim() ? parse(l) : null }));
  const errors = results.filter((x) => x.r?.error);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <textarea id={id} className="rules" rows={Math.max(3, results.length + 1)} spellCheck="false" placeholder={placeholder} value={text}
        aria-invalid={errors.length > 0}
        onChange={(e) => {
          setText(e.target.value);
          const parsed = e.target.value.split('\n').filter((l) => l.trim()).map(parse);
          if (parsed.every((p) => !p.error)) onValid(parsed.map((p) => p.rule));
        }} />
      {errors.map((x) => <p key={x.n} className="field-error">Ligne {x.n} : {x.r.error}</p>)}
    </div>
  );
}

function CiscoAcls({ data, update }) {
  const [name, setName] = useState('');
  const acls = data.acls ?? {};
  const add = () => {
    const n = name.trim();
    if (!n || acls[n]) return;
    update((d) => ({ ...d, acls: { ...d.acls, [n]: { type: aclTypeOf(n) ?? 'extended', rules: [] } } }));
    setName('');
  };
  return (
    <>
      <p className="label">Listes de contrôle d'accès (ACL)</p>
      {Object.entries(acls).map(([n, acl]) => (
        <fieldset key={n} className="iface">
          <legend>ACL {n} <span className="muted">· {acl.type === 'standard' ? 'standard' : 'étendue'}</span></legend>
          {!aclTypeOf(n) && (
            <select aria-label={`Type de l'ACL ${n}`} value={acl.type} onChange={(e) => update((d) => ({ ...d, acls: { ...d.acls, [n]: { ...acl, type: e.target.value } } }))}>
              <option value="extended">étendue (protocole, source, destination)</option>
              <option value="standard">standard (source seulement)</option>
            </select>
          )}
          <RulesEditor key={acl.type} label="Règles (syntaxe IOS, une par ligne)" lines={(acl.rules ?? []).map((r) => ruleText(r, acl.type))}
            placeholder={acl.type === 'standard' ? 'deny 192.168.1.0 0.0.0.255\npermit any' : 'deny icmp 192.168.1.0 0.0.0.255 host 10.0.0.5\npermit ip any any'}
            parse={(l) => parseAclLine(l, acl.type)} onValid={(rules) => update((d) => ({ ...d, acls: { ...d.acls, [n]: { ...d.acls[n], rules } } }))} />
          <button type="button" className="ghost small" onClick={() => update((d) => {
            const copy = { ...d.acls };
            delete copy[n];
            return { ...d, acls: copy };
          })}>Supprimer l'ACL {n}</button>
        </fieldset>
      ))}
      <div className="rows-item">
        <div className="field">
          <label htmlFor="new-acl">Nouvelle ACL (numéro ou nom)</label>
          <input id="new-acl" placeholder="10, 100 ou BLOQUE_WEB" value={name} onChange={(e) => setName(e.target.value.replace(/\s/g, ''))}
            onKeyDown={(e) => e.key === 'Enter' && add()} />
        </div>
        <button type="button" className="ghost small" onClick={add}>Créer</button>
      </div>
      <p className="hint">Rien ne correspond ? Refus implicite à la fin. L'application se fait dans chaque interface (entrée / sortie).</p>
    </>
  );
}

function CiscoNat({ data, update, ifaceNames }) {
  const nat = data.nat ?? { statics: [], dynamic: [] };
  const set = (fn) => update((d) => ({ ...d, nat: fn(d.nat ?? { statics: [], dynamic: [] }) }));
  const pat = nat.dynamic?.find((r) => r.iface) ?? null;
  return (
    <>
      <p className="label">NAT / PAT</p>
      <div className="field-row">
        <div className="field">
          <label htmlFor="pat-acl">PAT : adresses à traduire (ACL)</label>
          <select id="pat-acl" value={pat?.acl ?? ''} onChange={(e) => set((n) => ({
            ...n, dynamic: [...(n.dynamic ?? []).filter((r) => !r.iface), ...(e.target.value ? [{ acl: e.target.value, iface: pat?.iface ?? ifaceNames[0], overload: true }] : [])],
          }))}>
            <option value="">Pas de PAT</option>
            {Object.keys(data.acls ?? {}).map((a) => <option key={a} value={a}>ACL {a}</option>)}
          </select>
        </div>
        {pat && (
          <div className="field">
            <label htmlFor="pat-if">vers l'adresse de</label>
            <select id="pat-if" value={pat.iface} onChange={(e) => set((n) => ({ ...n, dynamic: n.dynamic.map((r) => (r === pat ? { ...r, iface: e.target.value } : r)) }))}>
              {ifaceNames.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </div>
        )}
      </div>
      {!Object.keys(data.acls ?? {}).length && <p className="hint">Crée d'abord une ACL standard (ex. 1 : permit 192.168.1.0 0.0.0.255).</p>}
      <p className="label">NAT statique (adresse privée ↔ publique)</p>
      {(nat.statics ?? []).map((st, i) => (
        <div className="rows-item" key={i}>
          {['local', 'global'].map((k) => (
            <div className="field" key={k}>
              <label htmlFor={`nat-${k}-${i}`}>{k === 'local' ? 'Privée' : 'Publique'}</label>
              <input id={`nat-${k}-${i}`} value={st[k]} aria-invalid={st[k] && !isValidIp(st[k]) ? true : undefined}
                onChange={(e) => set((n) => ({ ...n, statics: n.statics.map((x, j) => (j === i ? { ...x, [k]: e.target.value.trim() } : x)) }))} />
            </div>
          ))}
          <button type="button" className="ghost small" aria-label="Retirer" onClick={() => set((n) => ({ ...n, statics: n.statics.filter((_, j) => j !== i) }))}>✕</button>
        </div>
      ))}
      <button type="button" className="ghost small" onClick={() => set((n) => ({ ...n, statics: [...(n.statics ?? []), { local: '', global: '' }] }))}>Ajouter un NAT statique</button>
      <p className="hint">Coche « NAT inside » et « NAT outside » dans les interfaces.</p>
    </>
  );
}

const parseNatRule = (text) => {
  const n = Object.fromEntries(text.trim().split(/\s+/).filter((t) => t.includes('=')).map((t) => [t.slice(0, t.indexOf('=')), t.slice(t.indexOf('=') + 1)]));
  const rule = { chain: n.chain, action: n.action, src: n['src-address'], dst: n['dst-address'], inIface: n['in-interface'], outIface: n['out-interface'], toAddresses: n['to-addresses'] };
  if (!['srcnat', 'dstnat'].includes(rule.chain)) return { error: 'chain=srcnat ou chain=dstnat attendu' };
  if (rule.chain === 'srcnat' && !['masquerade', 'src-nat'].includes(rule.action)) return { error: 'action=masquerade ou src-nat attendu' };
  if (rule.chain === 'dstnat' && rule.action !== 'dst-nat') return { error: 'action=dst-nat attendu' };
  if (rule.action !== 'masquerade' && !isValidIp(rule.toAddresses)) return { error: 'to-addresses attendu' };
  return { rule: Object.fromEntries(Object.entries(rule).filter(([, v]) => v !== undefined)) };
};
const natText = (r) => [`chain=${r.chain}`, `action=${r.action}`, r.src && `src-address=${r.src}`, r.dst && `dst-address=${r.dst}`,
  r.inIface && `in-interface=${r.inIface}`, r.outIface && `out-interface=${r.outIface}`, r.toAddresses && `to-addresses=${r.toAddresses}`].filter(Boolean).join(' ');

export function SecurityForm({ node, update, ifaceNames, issues = [] }) {
  const d = node.data;
  const problems = issues.filter((i) => /ACL|NAT/.test(i.text)).map((i) => i.text);
  const mk = isMikrotik({ type: node.type, model: d.model });
  const active = Boolean(d.acls || d.nat || d.firewall?.length || d.natRules?.length);
  return (
    <details className="proto" open={active}>
      <summary>{mk ? 'Pare-feu et NAT' : 'ACL et NAT'} {active && <span className="badge-on">actif</span>}</summary>
      {problems.map((p) => <p key={p} className="field-error">{p}</p>)}
      {mk ? (
        <>
          <RulesEditor label="Pare-feu (/ip firewall filter, une règle par ligne)" lines={(d.firewall ?? []).map(firewallRuleText)}
            placeholder="chain=forward action=drop protocol=icmp src-address=192.168.1.0/24"
            parse={parseFirewallRule} onValid={(rules) => update((x) => ({ ...x, firewall: rules }))} />
          <RulesEditor label="NAT (/ip firewall nat)" lines={(d.natRules ?? []).map(natText)}
            placeholder="chain=srcnat action=masquerade out-interface=ether1"
            parse={parseNatRule} onValid={(rules) => update((x) => ({ ...x, natRules: rules }))} />
        </>
      ) : (
        <>
          <CiscoAcls data={d} update={update} />
          <CiscoNat data={d} update={update} ifaceNames={ifaceNames} />
        </>
      )}
    </details>
  );
}

// Dans la fiche d'une interface Cisco : NAT inside / outside et ACL entrée / sortie
export function InterfaceSecurity({ node, name, patch }) {
  const d = node.data;
  if (isMikrotik({ type: node.type, model: d.model })) return null;
  const e = d.ifaces?.[name] ?? {};
  const acls = Object.keys(d.acls ?? {});
  return (
    <div className="iface-security">
      <div className="checks">
        {[['natInside', 'NAT inside'], ['natOutside', 'NAT outside']].map(([k, label]) => (
          <label className="check" key={k}>
            <input type="checkbox" checked={Boolean(e[k])} onChange={(ev) => patch({ [k]: ev.target.checked || undefined })} /> {label}
          </label>
        ))}
      </div>
      {acls.length > 0 && (
        <div className="field-row">
          {[['aclIn', 'ACL en entrée'], ['aclOut', 'ACL en sortie']].map(([k, label]) => (
            <div className="field" key={k}>
              <label htmlFor={`${k}-${name}`}>{label}</label>
              <select id={`${k}-${name}`} value={e[k] ?? ''} onChange={(ev) => patch({ [k]: ev.target.value || undefined })}>
                <option value="">Aucune</option>
                {acls.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
