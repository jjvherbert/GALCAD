// Ponte mínima para a página: só o endereço e o token do agente embutido e a versão da app.
// A página não tem acesso ao Node nem ao sistema de ficheiros.
const { contextBridge } = require("electron");

const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").slice(k.length + 3);
const [url, token] = arg("cad-agent").split("|");
contextBridge.exposeInMainWorld("cadDesktop", Object.freeze({ agent: url && token ? { url, token } : null, version: arg("cad-version") }));
