const App = {
  sw: null,
  async init() {
    if ("serviceWorker" in navigator) {
      const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      App.sw = registration.installing || registration.waiting || registration.active;  

      console.log("Service worker registered");

      navigator.serviceWorker.addEventListener("controllerchange", () => {
        console.log("New service worker activated");
      });
    } else {
      console.error("Service workers are not supported");
    }
  },
};

document.addEventListener("DOMContentLoaded", async () => await App.init());

// TODO Handle updating list with todos
