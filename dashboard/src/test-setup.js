import "@testing-library/jest-dom/vitest";

window.matchMedia ||= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
