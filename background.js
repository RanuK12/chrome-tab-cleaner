// Script para limpiar pestañas inactivas de forma eficiente
const INACTIVITY_THRESHOLD_MINUTES = 30;

const cleanTabs = () => {
  chrome.tabs.query({ active: false, currentWindow: false }, (tabs) => {
    const now = Date.now();
    tabs.forEach((tab) => {
      // Verificamos la última interacción
      const lastActive = tab.lastAccessed || tab.lastFocused;
      
      if (lastActive && (now - lastActive) > (INACTIVITY_THRESHOLD_MINUTES * 60 * 1000)) {
        // Evitar cerrar pestañas de páginas muy importantes (opcional, pero recomendado)
        const protectedSites = ['google.com', 'github.com', 'gmail.com'];
        const isProtected = protectedSites.some(site => tab.url.includes(site));
        
        if (!isProtected) {
          chrome.tabs.remove(tab.id);
        }
      }
    });
  });
};

// Ejecución periódica
chrome.alarms.create("cleanTabs", { periodInMinutes: 5 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "cleanTabs") {
    cleanTabs();
  }
});

// Acción manual al hacer clic en el icono
chrome.action.onClicked.addListener(() => {
  cleanTabs();
  console.log("Manual clean triggered");
});