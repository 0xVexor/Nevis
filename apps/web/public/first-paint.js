      // Restore the device's appearance before the splash or sign-in page is painted.
      ;(function () {
        try {
          var s = JSON.parse(localStorage.getItem("nevis.device") || "null") || {}
          var dark = s.theme === "dark" || (s.theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches)
          var r = document.documentElement, st = r.style
          r.lang = s.lang === "fa" ? "fa" : "en"
          r.dir = s.dir === "rtl" || s.dir === "ltr" ? s.dir : r.lang === "fa" ? "rtl" : "ltr"
          if (s.theme === "light" || s.theme === "dark") r.dataset.theme = s.theme
          st.setProperty("--sp-bg", dark ? "#191c20" : "#fcfcfb")
          st.setProperty("--sp-text", dark ? "#e9eee9" : "#222923")
          st.setProperty("--sp-accent", s.accent ? (dark ? "color-mix(in oklab, " + s.accent + " 78%, #fff)" : s.accent) : dark ? "#65b5a7" : "#087f74")
          st.background = dark ? "#191c20" : "#fcfcfb"
          st.colorScheme = dark ? "dark" : "light"
        } catch (e) {}
      })()
