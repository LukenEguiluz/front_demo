// app.js
document.addEventListener("DOMContentLoaded", () => {
  const menuItems = document.querySelectorAll(".menu-item");
  const screens = document.querySelectorAll(".screen");

  menuItems.forEach(item => {
    item.addEventListener("click", e => {
      e.preventDefault();

      // activar item de menú
      menuItems.forEach(i => i.classList.remove("active"));
      item.classList.add("active");

      const targetId = item.getAttribute("href").substring(1);

      // mostrar pantalla correspondiente
      screens.forEach(screen => {
        if (screen.id === targetId) {
          screen.classList.add("screen-active");
        } else {
          screen.classList.remove("screen-active");
        }
      });
    });
  });
});
