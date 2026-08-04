# AI-First IDE — Piano di sviluppo

Documento master: visione, decisioni, indice. Le specifiche step by step stanno nei dieci file in `docs/phases`.

## Come usare questo piano

1. Le decisioni di questo file sono **già prese**: non si rimettono in discussione senza richiesta del proprietario.
2. Si lavora una fase alla volta, nell'ordine: non si prosegue senza i criteri di uscita.
3. Ogni ambiguità si risolve scegliendo l'opzione che avvicina la vertical slice della Fase 10.
4. Ogni decisione va scritta nel file di fase, e qui se cambia un vincolo globale.

## Visione

Un IDE in cui **l'AI è l'operatore primario del codice** e l'umano è il regista: descrive obiettivi, verifica nel browser, approva i diff e registra il comportamento atteso come test Cypress. Editor e terminale restano viste on-demand, non la superficie principale.

Principi: conversazione al centro; local-first senza account né telemetria; ogni azione produce un artefatto ispezionabile; il test è il contratto; sandbox per default, autonomia per scelta; tre OS dal primo giorno; una sola configurazione obbligatoria, la Base URL.

## Non-goals dell'MVP

Fuori perimetro: fork di Code - OSS ed estensioni VS Code, debugger con breakpoints, sistema di plugin, workspace remoti, notebook, multi-agent, autocomplete inline, distribuzione pubblica, backend proprietario.

## Decisioni vincolanti

- **Base tecnica**: Electron custom. TypeScript rigoroso ovunque, React e Vite nel renderer, Monaco on-demand.
- **Provider**: protocollo OpenAI-compatible con Base URL configurabile, nessun provider hardcoded.
- **Agent**: uno solo, con tool specializzati, in quattro modalità: Ask, Plan, Agent, Autonomous.
- **Sicurezza**: il workspace è l'unico perimetro di scrittura; diff live e checkpoint locali; **nessun commit automatico**; push non disponibile all'agent.
- **Segreti**: valori in `.env.*` gitignorati; l'agent li scrive ma **non ne legge mai i valori**; redazione dei log non disattivabile.
- **Ambienti**: un manifest versionato descrive servizi, comandi, porte, scope env, healthcheck, seed e cleanup.
- **Architecture profile**: `.aifi/ARCHITECTURE.md` (intent + sparse overrides); stack is detected from the repo — vedi [architecture-profile.md](architecture-profile.md).
- **QA**: recorder umano che genera test Cypress leggibili e versionati, rifiniti dall'agent.
- **Dati**: tutto locale, credenziali solo nel keychain di sistema.
- **Distribuzione**: solo build interne, nessuna firma né auto-update.

## Modalità

Quattro livelli di autonomia scelti per sessione: **Ask** (sola lettura), **Plan** (lettura più comandi in allowlist), **Agent** (scrittura con diff e checkpoint, comandi con conferma fuori allowlist, servizi e QA), **Autonomous** (come Agent ma conferma solo per azioni distruttive). Ovunque: scrittura confinata al workspace, azioni distruttive sempre confermate, modalità non persistente. Matrice completa nella Fase 5.

## Architettura

Renderer React senza privilegi, bridge IPC tipizzato e validato, main process con orchestratore di sessione, runtime agent e **tool gateway**: unico punto di esecuzione, applica policy, rischio, redazione e audit. Dietro il gateway: filesystem sandbox, Git, PTY, supervisor, env, Cypress, storage, keychain. Browser QA e servizi del progetto girano isolati fuori dal processo principale.

Monorepo: `apps/desktop`, `apps/renderer`, `packages/shared`, `packages/storage`, `packages/provider`, `packages/workspace`, `packages/tools`, `packages/agent`, `packages/environment`, `packages/qa`, `fixtures/demo-project`, `docs`.

## Le dieci fasi

1. [Discovery tecnica](phases/01-discovery-tecnica.md) — prototipi PTY, browser, recorder, keychain.
2. [Fondamenta applicative](phases/02-fondamenta-applicative.md) — monorepo, Electron sicuro, IPC, storage.
3. [Provider AI e onboarding](phases/03-provider-e-onboarding.md) — client reale e mock, Base URL, modelli.
4. [Workspace, Git e checkpoint](phases/04-workspace-git-checkpoint.md) — sandbox, ricerca, diff, ripristino.
5. [Tool gateway e permessi](phases/05-tool-gateway-e-permessi.md) — tool, rischio, modalità, approvazioni.
6. [Runtime agent](phases/06-runtime-agent.md) — ciclo del turno, contesto, limiti, piano.
7. [Cockpit e pannelli](phases/07-cockpit-ui.md) — conversazione, approvazioni, diff, terminale.
8. [Ambienti, servizi ed env](phases/08-ambienti-servizi-env.md) — manifest, supervisor, Docker, segreti.
9. [Browser QA e recorder](phases/09-qa-browser-e-recorder.md) — verifica visuale, registrazione, Cypress.
10. [Hardening, slice e beta](phases/10-hardening-slice-e-beta.md) — sicurezza, prestazioni, accettazione.

## Definition of Done

Una funzionalità è completa quando rispetta le decisioni di questo file, ha test al livello appropriato (almeno uno di integrazione se attraversa il tool gateway), passa lint, tipi e suite in CI, funziona sui tre OS o documenta la limitazione, non aggira gateway, sandbox o redazione, e mostra progresso interrompibile con errori comprensibili.

L'MVP è raggiunto quando la vertical slice della Fase 10 si completa sui tre OS, con zero fughe di segreti, zero scritture fuori dal workspace e zero processi orfani.
