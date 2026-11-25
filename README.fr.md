# AI Tech Watch

**Un workflow n8n qui transforme des annonces officielles sur l’IA en idées de posts vérifiées — et qui refuse d’inventer un chiffre.**

Chaque matin (ou à la demande), mon agent IA lit un petit ensemble de **sources primaires**, ne retient que ce qui a été publié dans les 48 dernières heures, le note, et rédige un digest pour **relecture humaine**. Si une idée n’a pas d’URL source, ou si elle utilise un nombre absent du texte source, elle est rejetée. Rien n’est publié automatiquement.

Un exemple abouti de ce que ce processus doit permettre — sept idées LinkedIn / X sourcées, datées du 24 novembre 2026 — se trouve dans [`examples/2026-11-24-tech-post-ideas.md`](examples/2026-11-24-tech-post-ideas.md). Le digest issu d’une exécution réelle de ce workflow est dans [`examples/sample-output.md`](examples/sample-output.md).

> English version: [README.md](README.md)

## Ce que fait mon agent IA

1. **Il surveille des flux officiels**, pas des agrégateurs : OpenAI News, Google DeepMind, le Google AI Blog, le blog Hugging Face et arXiv cs.AI.
2. **Il normalise et déduplique** par URL canonique, puis écarte tout ce qui a plus de 48 heures.
3. **Il note** les items avec une liste de mots-clés explicite. Les billets officiels dans la fenêtre sont conservés ; les papiers arXiv doivent passer un score minimum et sont plafonnés, pour que le digest reste lisible.
4. **Il extrait des faits vérifiables** et propose un angle de post. Si une clé d’API compatible OpenAI est présente, un LLM s’en charge, obligé de renvoyer du JSON et de reprendre l’URL source telle quelle. Si la clé manque ou si l’appel échoue, le workflow construit quand même un digest à partir des titres et des extraits sources.
5. **Il valide, puis s’arrête pour un humain.** Chaque idée retenue porte le drapeau `needs_review`. C’est un humain qui décide ce qui, le cas échéant, est publié.

## Architecture

Le schéma est le même que dans le [README anglais](README.md#architecture). En résumé : deux déclencheurs (planification quotidienne à 07:00 Europe/Paris, et manuel) alimentent cinq flux en parallèle, puis une chaîne *normaliser → scorer → LLM ou repli → valider → digest*, avec un gestionnaire d’erreur à part.

Les requêtes vers les flux **réessayent** et **continuent en cas d’échec**. Un flux cassé ne doit jamais faire tomber tout le run. Le nœud HTTP du LLM se comporte de la même façon : un appel raté bascule sur un digest « source uniquement », au lieu de faire échouer tout le travail.

## Les nœuds, section par section

| Section | Nœuds | Rôle |
| --- | --- | --- |
| 1. Déclencheurs | `Trigger · Schedule (daily 07:00 Paris)`, `Trigger · Manual` | La même chaîne, à l’heure ou à la demande. Fuseau : Europe/Paris. |
| 2. Flux officiels | cinq nœuds `RSS · …`, cinq nœuds `Tag · …`, `Merge · All feeds` | Récupération en parallèle, étiquetage de la source, fusion. |
| 3. Normalisation et score | `Code · Normalize, dedupe & 48h window`, `Code · Keyword score & rank` | URL canoniques, fenêtre de 48 h, déduplication, score, plafond arXiv. |
| 4. LLM avec repli | `Code · Prepare LLM request`, `IF · LLM credential present`, `HTTP · LLM extract facts & angles`, `NoOp · Skip LLM`, `Merge · LLM or fallback`, `Code · Parse LLM or fallback` | Un appel JSON chat-completions si une clé est posée ; sinon (ou en cas d’erreur) des faits courts recopiés du texte source. |
| 5. Validation et écriture | `Code · Validate sources & figures`, `Code · Build Markdown digest`, `Convert · Digest to file`, `Write · Digest to disk` | Rejet des idées non sourcées ou infidèles sur les chiffres, rédaction du digest, fichier sur disque. |
| 6. Relecture humaine | `IF · Notifications enabled`, `NoOp · Notifications off`, Slack / Gmail / Sheets optionnels | Chaque idée reste `needs_review`. Les notifications restent éteintes tant que `ENABLE_NOTIFICATIONS` n’est pas `true` et que les identifiants factices n’ont pas été remplacés. |
| 7. Erreurs | `Error Trigger`, `Code · Format error report`, conversion + écriture | Les pannes non gérées deviennent une note d’incident. Dans les réglages n8n, désigner ce workflow comme *Error workflow*. |

Les scripts des nœuds Code sont dans [`workflow/src/`](workflow/src/) et sont assemblés dans [`workflow/ai-tech-watch.json`](workflow/ai-tech-watch.json) par [`workflow/src/build_workflow.py`](workflow/src/build_workflow.py). Des notes adhésives sur le canevas documentent les mêmes sept sections.

## Garde-fous

- **Sources primaires uniquement.** Les cinq URL du workflow ont été vérifiées en conditions réelles avant d’être figées. Aucun site de recension non officiel n’est dans le parcours.
- **Pas de chiffre inventé.** Le validateur extrait les nombres des faits et de l’angle, et rejette tout nombre absent du titre, de l’extrait, de l’URL ou de la date de la source.
- **L’URL source est obligatoire.** Une idée sans `source_url`, ou dont l’URL ne correspond à aucun item récupéré, est rejetée.
- **La validation humaine est la dernière étape.** Le digest porte `needs_review`. Ce workflow ne publie pas sur LinkedIn ni sur X, et n’envoie rien vers Slack, l’e-mail ou Sheets à moins que vous ne l’activiez volontairement.
- **Échec ouvert sur les flux, échec prudent sur les faits.** Un flux indisponible est consigné dans le tableau de santé du digest. Une idée sloppy est écartée, pas publiée.

## Importer dans n8n

Il faut Node.js 18+ et le CLI n8n (ce workflow a été importé et exécuté sur **n8n 2.49.6**).

```bash
npm i -g n8n

n8n import:workflow --input=workflow/ai-tech-watch.json
n8n list:workflow
```

Puis, dans l’éditeur n8n (`n8n start`), ouvrir **AI Tech Watch — official feeds to fact-checked post ideas**, et dans **Workflow Settings** :

1. Vérifier que le fuseau est `Europe/Paris`.
2. Définir le **Error workflow** sur ce même workflow, pour que l’Error Trigger reçoive les pannes non gérées.
3. Laisser le workflow **inactif** tant que vous ne voulez pas que la planification de 07:00 se déclenche. Un run manuel n’a pas besoin d’activation.

Après modification d’un script de nœud Code, reconstruire le JSON :

```bash
python3 workflow/src/build_workflow.py
```

## Identifiants et variables d’environnement

| Nom | Obligatoire ? | Rôle |
| --- | --- | --- |
| `OPENAI_API_KEY` | Non | Si elle est posée, le nœud HTTP appelle `$OPENAI_BASE_URL/chat/completions`. Sinon, le chemin de repli produit quand même un digest. |
| `OPENAI_BASE_URL` | Non | Point de terminaison compatible. Défaut : `https://api.openai.com/v1`. |
| `OPENAI_MODEL` | Non | Défaut : `gpt-4o-mini`. |
| `LOOKBACK_HOURS` | Non | Défaut : `48`. |
| `DIGEST_PATH` | Non | Emplacement du fichier Markdown. Défaut : `/tmp/ai-tech-watch-digest.md`. |
| `ENABLE_NOTIFICATIONS` | Non | Doit valoir exactement `true` pour atteindre Slack, Gmail ou Sheets. Éteint par défaut. |
| Identifiants Slack / Gmail / Google Sheets | Seulement si les notifications sont allumées | Le JSON contient des identifiants **factices**. Il faut les remplacer dans l’interface n8n avant d’activer les notifications. |

Copier [`.env.example`](.env.example) vers `.env` pour un essai local. Ne pas committer de secret. Le nœud HTTP lit la clé dans l’environnement ; aucune clé n’est stockée dans le fichier du workflow.

## Lancer le workflow

**Dans l’éditeur n8n :** ouvrir le workflow et cliquer sur **Test workflow** (cela utilise `Trigger · Manual`).

**En ligne de commande** (après import). Dans n8n 2.49, le drapeau `--file` n’est plus supporté ; il faut importer, puis exécuter par identifiant :

```bash
# Nécessaire si les nœuds Code doivent lire OPENAI_API_KEY, LOOKBACK_HOURS, DIGEST_PATH, …
export N8N_BLOCK_ENV_ACCESS_IN_NODE=false

# n8n 2.x n’écrit des fichiers que sous N8N_RESTRICT_FILE_ACCESS_TO (défaut : ~/.n8n-files)
export N8N_RESTRICT_FILE_ACCESS_TO="$HOME/.n8n-files;/tmp"
export DIGEST_PATH="/tmp/ai-tech-watch-digest.md"

n8n list:workflow
n8n execute --id=<workflow-id>
```

Un script de commodité qui pose ces variables et importe le JSON :

```bash
# optionnel : export OPENAI_API_KEY=...
./scripts/run-once.sh
```

Les nœuds Code peuvent aussi être testés sans n8n :

```bash
node workflow/src/test_code_nodes.js
node workflow/src/test_code_nodes.js --live   # interroge les cinq flux officiels
```

## Exemples de sortie

Voir [`examples/sample-output.md`](examples/sample-output.md) pour un digest produit par une exécution réelle sous n8n 2.49.6, le 26 novembre 2026 à 00:22 Europe/Paris. Les cinq flux ont répondu. Le run a ingéré 2 914 items, en a conservé 458 dans la fenêtre de 48 heures, proposé 16 idées, et n’en a rejeté aucune. Aucune clé d’API n’était posée, donc l’étape LLM a été sautée et les faits viennent des titres et des extraits sources. Chaque item porte le drapeau `needs_review`.

Le dossier éditorial du 24 novembre 2026, dans [`examples/2026-11-24-tech-post-ideas.md`](examples/2026-11-24-tech-post-ideas.md), est un jeu fini d’ébauches de posts, chacune liée à sa source officielle, sans chiffre inventé, et sans publication sans feu vert humain.

## Ce que ce dépôt ne fait pas

- Il ne publie pas, ne programme pas et ne répond pas tout seul sur LinkedIn ou X.
- Il ne moissonne pas de sites de recension non officiels.
- Il ne traite pas une phrase de LLM comme un fait avant le passage du validateur, puis d’un humain.
- Il n’allume pas Slack, Gmail ou Sheets à moins que vous ne posiez des identifiants et `ENABLE_NOTIFICATIONS=true`.
