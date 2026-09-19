// Ré-export de la configuration centralisée (compatibilité des imports).
//
// La source de vérité unique est `config.js` à la racine : elle lit le
// comportement de la passerelle depuis les variables d'environnement
// injectées par l'hébergeur (Render/Docker) ou depuis le `.env` local
// chargé par `lib/env.js`.

export {
  APP_NAME,
  APP_AUTHOR,
  APP_VERSION,
  APP_TAGLINE,
  DEFAULT_MODEL,
  DEFAULT_TEMPLATE,
  DEFAULT_SYSTEM_PROMPT,
  DOLPHIN_BASE_URL,
  DOLPHIN_USER_AGENT,
  DEFAULTS,
  getConfig,
} from "../config.js";
