// index.js — point d'entrée générique.
//
// Les plateformes qui ne reçoivent pas de start command explicite cherchent
// `index.js` par défaut (Render exécute « node index.js »). Le serveur réel
// est dans server.js ; ce fichier ne fait que le démarrer.

import { startServer } from "./server.js";

startServer();
