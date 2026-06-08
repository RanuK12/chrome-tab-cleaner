// Script para limpiar pestañas inactivas
// Criterio: Pestañas que no han sido vistas en X minutos y no son la pestaña activa.

const INACTIVITY_THRESHOLD_MINUTES = 30;

chrome.tabs.query({ active: false, currentWindow: false }, (tabs) => {
  const now = Date.now();
  
  tabs.forEach((tab) => {
    // Usamos el timestamp de la última vez que se interactuó (si el navegador lo provee)
    // O calculamos por el tiempo de creación si no hay datos de interacción.
    const lastActive = tab.lastAccessed || tab.lastFocused;
    
    if (lastActive && (now - lastActive) > (INACTIVITY_THRESHOLD_MINUTES * 60 * 1000)) {
      // Verificamos que no sea una pestaña de sistema o protegida (opcional)
      chrome.tabs.remove(tab.id);
    }
  });
});

// Ejecución periódica cada 5 minutos para mantener la RAM limpia
chrome.alarms.create("cleanTabs", { periodInMinutes: 5 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "cleanTabs") {
    chrome.tabs.query({ active: false, currentWindow: false }, (tabs) => {
      const now = Date.now();
      tabs.forEach((tab) => {
        const lastActive = tab.lastAccessed || tab.lastFocused;
        if (lastActive && (now - lastActive) > (INACTIVITY_THRESHOLD_MINUTES * 60 * 1000)) {
          chrome.tabs.remove(tab.id);
        }
      });
    });
  }
});