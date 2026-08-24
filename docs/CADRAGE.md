# Navi v2 — Dossier de cadrage

Synthèse des décisions issues de la discussion d'architecture, avant tout début
d'implémentation. Ce document est la conclusion ; le détail technique (diagrammes,
workflows complets, tables de fallback) reste dans [`ARCHITECTURE.md`](./ARCHITECTURE.md).

---

## 1. Contexte et objectif

Navi est un assistant d'accessibilité pour des personnes avec mobilité, dextérité, ou
lecture réduites ("PMR" dans le code original). Deux piliers :

1. **Adapter sa propre interface** aux capacités mesurées de l'utilisateur.
2. **Agir pour le compte de l'utilisateur** dans une WebView embarquée, piloté à la voix.

> Mise à jour : mapping des 3 mini-jeux verrouillé le 2026-08-21, voir
> [`MINI_GAMES.md`](./MINI_GAMES.md) et §5 ci-dessous.

Ce projet est un **rebuild complet, from scratch**, dans un nouveau dossier
(`Navi_v2.0`), sans dépendance à l'ancien code. Double objectif assumé : livrer un
produit réellement solide (l'ancienne adaptation ne fonctionnait pas bien), et pratiquer
pour de vrai des protocoles agentiques (A2A, MCP) dans un cas d'usage concret plutôt que
jouet.

---

## 2. Conclusions de la discussion

Décisions actées, dans l'ordre où elles ont été prises :

| Sujet | Décision |
|---|---|
| Base de code | 100% neuve, le spec de l'ancien projet sert de référence de     comportement uniquement, pas de portage de code. |
| Structure repo | Mono-repo — `apps/mobile` + `backends` dans le même repo, comme l'ancien projet. |
| Publication / comptes | Tout reste en fichiers locaux dans le repo (`docs/`). Pas de publication via l'outil Artifact Claude, pour ne jamais mélanger ce projet personnel avec le compte Claude Pro professionnel connecté à cette session. |
| Sortie vocale | TTS ajouté — absent de l'ancien projet, mais cohérent avec le public cible (difficultés de lecture). |
| Cible MVP | Pas de diagnostic médical. Trois axes de capacité **fonctionnelle** mesurés (voir §5), inspirés de profils Parkinson / dyslexie / autisme (style perceptif), mais jamais stockés comme tels. |
| Décision d'adaptation | Raisonnement LLM (pas de seuils fixes) + validateur déterministe en dur pour la sécurité + apprentissage bandit contextuel sur le signal accepter/refuser. Aucun contenu de décision hardcodé, y compris dans les chemins de repli (voir §6). |
| Apprentissage | Bandit contextuel, pas de RL séquentiel complet — volume de données réel insuffisant au démarrage, et l'exploration d'un RL classique entrerait en conflit avec la garantie "jamais plus de friction". |
| Frameworks agents | LangGraph pour la boucle de raisonnement de chaque agent ; LangChain (core) en support bas niveau ; LangSmith pour la traçabilité. |
| Protocoles | A2A entre l'orchestrateur et les agents spécialistes ; MCP pour l'accès aux outils (données, navigateur, scanner, lecteur web). Détail et justification en §4. |
| Adaptation de sites tiers (pub/clutter, style générique) | **Mise à jour 2026-08-23** : le but produit réel étant d'adapter n'importe quel site, cette partie est intégrée à la séquence de build principale plutôt que repoussée après elle — voir [`THIRD_PARTY_ADAPTATION.md`](./THIRD_PARTY_ADAPTATION.md) pour la conception (vocabulaire d'adaptation générique, pipeline de classification pour le décluttering, frontière de sécurité généralisée à un DOM non borné) et `ARCHITECTURE.md` §9 pour l'ordre de construction révisé. |

---

## 3. Architecture des agents — vue synthétique

```
Utilisateur
   │ voix / texte
   ▼
Agent Orchestrateur (LangGraph)  ── seul agent qui parle à l'utilisateur
   │
   │  délégation de tâche via A2A
   ├──────────────────────────────┐
   ▼                              ▼
Agent Profiling & Adaptation   Agent Automatisation de tâche
(LangGraph)                    (LangGraph)
   │ MCP                          │ MCP
   ▼                              ▼
Data MCP (Supabase)          Browser Bridge MCP ↔ WebView mobile
                              Scanner MCP (OCR)
                              Web Reader MCP (lecture de pages)
```

Le détail complet (diagramme ASCII étendu, workflows pas à pas, tables de fallback) est
dans `ARCHITECTURE.md` §1, §3, §4.

**Pourquoi deux agents spécialistes et pas un seul bloc** : ils portent une autorité
distincte — l'un décide *quoi changer dans l'interface*, l'autre décide *quelle action
faire dans le navigateur*. C'est une séparation de responsabilité réelle, pas artificielle.

---

## 4. Protocoles utilisés — et pourquoi, précisément ici

### A2A (Agent2Agent)
Utilisé entre l'Orchestrateur et les deux agents spécialistes. Justifié parce que ces
agents ont une autorité et un cycle de vie séparés (voir §3), pas parce que le protocole
est à la mode. Point d'attention : **aucun framework ne fournit ça prêt à l'emploi** — il
faut écrire une petite couche qui expose chaque graphe LangGraph derrière une interface
A2A (Agent Card + endpoint de tâches), en s'appuyant sur les exemples de référence
publiés par Google. C'est là que la pratique réelle du protocole a lieu.

### MCP (Model Context Protocol)
Utilisé pour exposer les capacités (données, navigateur, scanner, lecture web) comme des
outils standardisés que n'importe quel agent peut appeler, au lieu d'imports directs.
`langchain-mcp-adapters` les branche nativement dans les nœuds LangGraph. Le serveur
**Browser Bridge** est le cas le plus intéressant techniquement : contrairement à un
serveur MCP classique (process local), il doit relayer chaque appel d'outil vers la
WebView du téléphone via une session WebSocket vivante — un vrai pont réseau, pas un
wrapper.

### Ce qui n'a volontairement pas été retenu
- **RL séquentiel complet** : pas assez de données au démarrage, risque d'exploration
  contraire à la garantie "jamais plus de friction". Le bandit contextuel est la version
  correctement dimensionnée du même principe.
- **Règles fixes pour la décision d'adaptation** (ancienne approche à seuils) : remplacées
  par le raisonnement LLM + validateur, cf. §2 et `ARCHITECTURE.md` §0.5 et §5.

---

## 5. Portée MVP — axes de capacité, sans diagnostic

Mapping verrouillé — détail complet (rationale, sources de recherche, framing non-diagnostic)
dans [`MINI_GAMES.md`](./MINI_GAMES.md).

| Cible perçue | Axe mesuré | Signaux | Mini-game associé |
|---|---|---|---|
| Parkinson (moteur) | Précision motrice | déviation de tracé, corrections, fluidité du mouvement | Follow the Path |
| Dyslexie (lecture) | Confort de lecture | vitesse de lecture, précision de compréhension, hésitation | Reading Challenge |
| Autisme (style perceptif) | Style de traitement visuel | temps de détection, taux d'erreur, sur complexité croissante | Pattern Detective |

**Charge cognitive retirée du mapping mini-jeux** : ses signaux (temps sur tâche, retours en
arrière, taux d'abandon) sont observables passivement dans l'usage normal de l'app, contrairement
au style de traitement visuel qui ne peut être capté que par une tâche dédiée. Peut rester un
signal passif ambiant plus tard, mais n'a pas de mini-jeu dans le MVP.

**"Équilibre du Verre" (maintien d'un verre stable) écarté** : maquetté en parallèle des trois
jeux ci-dessus, mais sans aucune source de recherche derrière (contrairement aux trois retenus) et
redondant avec l'axe moteur via un mécanisme différent (maintien statique vs tracé dynamique).
Voir `MINI_GAMES.md` §1.

**Aucun champ "condition"/diagnostic n'existe nulle part dans le système** — uniquement
ces scores fonctionnels. C'est un choix produit et légal, pas seulement éthique : ça
maintient le système hors du champ des dispositifs médicaux réglementés.

---

## 6. Principes non négociables (recap)

Repris intégralement de `ARCHITECTURE.md` §0 — à ne jamais contourner pour une démo ou
par facilité :

1. Consentement à deux niveaux (proposer, jamais imposer).
2. Aucun diagnostic médical stocké.
3. `user_id` uniquement depuis un token vérifié, jamais depuis le corps de la requête.
4. RLS appliqué via le token de l'appelant pour toute lecture.
5. Frontières de sécurité = code déterministe ; contenu de décision = jamais en dur.
6. Vocabulaire d'actions du navigateur fermé et validé.
7. Les fusions de preuves en arrière-plan ne doivent jamais lever d'exception.
8. Aucun échec silencieux — chaque frontière réseau/modèle a un repli explicite.

---

## 7. Prochaines étapes

1. ~~**Doc mini-games**~~ → fait, voir [`MINI_GAMES.md`](./MINI_GAMES.md) et §5. Mapping
   1 jeu = 1 axe verrouillé (Follow the Path / Reading Challenge / Pattern Detective).
   Reste ouvert : schéma exact de télémétrie par jeu (champs précis dans `evidence_log`).
2. **Transport chat** (SSE vs WebSocket) → à trancher ; le Browser Bridge impose de toute
   façon un WebSocket, ce qui peut orienter le choix par proximité technique.
3. **Recherches à mener avant de coder** — liste complète dans `ARCHITECTURE.md` §8
   (spec A2A, transport MCP distant, `langchain-mcp-adapters`, bandit contextuel,
   LangSmith, bridge WebView Expo, choix STT/TTS).
4. **Ordre de construction** — plan détaillé en 9 étapes dans `ARCHITECTURE.md` §9,
   démarrage prévu par la couche données + auth.

---

## 8. Documents du dossier

- **`ARCHITECTURE.md`** — référence technique complète : composants, workflows détaillés,
  modèle de données, table de fallback exhaustive, limites de sécurité, plan de
  construction.
- **`MINI_GAMES.md`** — mapping verrouillé des 3 mini-jeux d'onboarding, rationale et
  sources de recherche par jeu, framing non-diagnostic.
- **`THIRD_PARTY_ADAPTATION.md`** — conception de l'adaptation de sites tiers : vocabulaire
  générique (Layer A), pipeline de décluttering (Layer B), frontière de sécurité pour un DOM
  non borné. Résout les deux points laissés ouverts dans `ARCHITECTURE.md` §8.
- **`CADRAGE.md`** (ce document) — synthèse des décisions et conclusion de la phase de
  discussion, architecture agents et protocoles en vue d'ensemble.
