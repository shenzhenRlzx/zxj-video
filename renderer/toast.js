const messageEl = document.getElementById('message');

window.toastApi.onToast(({ message }) => {
  messageEl.textContent = message || '--';
});
