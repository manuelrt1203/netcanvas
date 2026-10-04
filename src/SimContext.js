import { createContext, useContext } from 'react';

// État de l'animation partagé avec les câbles et les équipements :
//   hop     : saut en cours { edge, from, to, phase, key } ou null
//   hops    : sauts affichés ensemble (pas à pas : une diffusion ARP allume plusieurs câbles)
//   edges   : Map edgeId -> 'request' | 'reply' des câbles déjà traversés
//   nodes   : Set des équipements déjà atteints
//   failedAt: équipement où le ping a échoué
export const EMPTY_SIM = { hop: null, hops: [], edges: new Map(), nodes: new Set(), failedAt: null };
export const SimContext = createContext(EMPTY_SIM);
export const useSim = () => useContext(SimContext);

// État des câbles (Map linkId -> { up, data, reason }), recalculé à chaque modification du schéma
export const LinkContext = createContext(new Map());
export const useLinkStatus = (id) => useContext(LinkContext).get(id);
