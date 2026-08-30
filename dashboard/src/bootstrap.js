export function removeBootstrapFragment(location = window.location, history = window.history) {
  const parameters = new URLSearchParams(location.hash.replace(/^#/, ""));
  const token = parameters.get("bootstrap");
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  return token;
}
