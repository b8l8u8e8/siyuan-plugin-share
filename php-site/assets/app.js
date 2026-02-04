(() => {
  "use strict";

  const refreshCaptcha = (img) => {
    const base = img.getAttribute("data-src") || img.getAttribute("src") || "";
    const clean = base.split("?")[0];
    img.setAttribute("data-src", clean);
    img.src = `${clean}?ts=${Date.now()}`;
  };

  document.querySelectorAll("img[data-captcha]").forEach((img) => {
    img.addEventListener("click", () => refreshCaptcha(img));
  });

  const scheduleIdle = (task, {timeout = 1200} = {}) => {
    if (typeof window.requestIdleCallback === "function") {
      return window.requestIdleCallback(task, {timeout});
    }
    return window.setTimeout(task, 0);
  };

  const tocCleanupMap = new WeakMap();
  let imageViewerReady = false;
  let shareNavReady = false;
  let commentEditorsGlobalBound = false;
  let shareDynamicToken = 0;

  const initAnnouncementModal = () => {
    const modal = document.querySelector("[data-announcement-modal]");
    if (!modal) return;
    const hideCheckbox = modal.querySelector("[data-announcement-hide]");
    const closeModal = () => {
      if (hideCheckbox && hideCheckbox.checked) {
        const now = new Date();
        const pad = (num) => String(num).padStart(2, "0");
        const today = [
          now.getFullYear(),
          pad(now.getMonth() + 1),
          pad(now.getDate()),
        ].join("-");
        document.cookie = `announcement_hide_date=${today}; path=/; max-age=86400`;
      }
      modal.remove();
    };
    modal.addEventListener("click", (event) => {
      const target = event.target;
      if (!target) return;
      if (
        target.closest("[data-modal-close]") ||
        target.classList.contains("modal-backdrop")
      ) {
        closeModal();
      }
    });
  };

  const initNav = () => {
    const navItems = Array.from(document.querySelectorAll(".app-nav .nav-item"));
    if (!navItems.length) return;
    const currentPath = window.location.pathname.replace(/\/+$/, "");

    const setActive = (target) => {
      navItems.forEach((item) => item.classList.remove("is-active"));
      if (target) target.classList.add("is-active");
    };

    const findItem = (hash) =>
      navItems.find((item) => {
        const itemPath = (item.dataset.navPath || "").replace(/\/+$/, "");
        const itemHash = item.dataset.navHash || "";
        if (itemPath && itemPath !== currentPath) return false;
        if (hash) return itemHash === hash;
        return !itemHash;
      });

    const updateByHash = () => {
      const hash = window.location.hash.replace(/^#/, "");
      const item = findItem(hash) || findItem("");
      setActive(item);
    };

    navItems.forEach((item) => {
      item.addEventListener("click", (event) => {
        if (
          event.defaultPrevented ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        const hash = item.dataset.navHash || "";
        const itemPath = (item.dataset.navPath || "").replace(/\/+$/, "");
        if (hash && itemPath === currentPath) {
          const target = document.getElementById(hash);
          if (target) {
            event.preventDefault();
            target.scrollIntoView({behavior: "smooth", block: "start"});
            history.replaceState(null, "", `#${hash}`);
            setActive(item);
          }
        }
      });
    });

    if ("IntersectionObserver" in window) {
      const hashTargets = navItems
        .map((item) => item.dataset.navHash || "")
        .filter(Boolean)
        .map((hash) => document.getElementById(hash))
        .filter(Boolean);
      if (hashTargets.length) {
        const observer = new IntersectionObserver(
          (entries) => {
            const visible = entries
              .filter((entry) => entry.isIntersecting)
              .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
            if (!visible) return;
            const item = findItem(visible.target.id);
            setActive(item);
          },
          {rootMargin: "-20% 0px -70% 0px", threshold: [0, 0.5, 1]},
        );
        hashTargets.forEach((el) => observer.observe(el));
      }
    }

    window.addEventListener("hashchange", updateByHash);
    updateByHash();
  };

  const initKnowledgeTree = () => {
    const toggles = document.querySelectorAll(".kb-tree-toggle");
    if (!toggles.length) return;
    const getShareSlug = () => {
      const host = document.querySelector("[data-share-slug]");
      const slug = host?.dataset?.shareSlug || "";
      if (slug) return slug;
      const match = window.location.pathname.match(/\/s\/([^/]+)/);
      return match ? match[1] : "";
    };
    const getStorageKey = () => {
      const slug = getShareSlug();
      return slug ? `sps-tree-state:${slug}` : "";
    };
    const readState = () => {
      const key = getStorageKey();
      if (!key) return new Set();
      try {
        const raw = localStorage.getItem(key);
        if (!raw) return new Set();
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return new Set();
        return new Set(parsed.filter(Boolean));
      } catch {
        return new Set();
      }
    };
    const writeState = (set) => {
      const key = getStorageKey();
      if (!key) return;
      try {
        const payload = JSON.stringify(Array.from(set));
        localStorage.setItem(key, payload);
      } catch {
        // ignore
      }
    };
    const syncState = () => {
      const openKeys = new Set();
      document.querySelectorAll(".kb-tree-node.is-open[data-tree-key]").forEach((node) => {
        const key = node.dataset.treeKey || "";
        if (key) openKeys.add(key);
      });
      writeState(openKeys);
    };
    const toggleNode = (node, nextOpen) => {
      node.classList.toggle("is-open", nextOpen);
      node.classList.toggle("is-collapsed", !nextOpen);
      const btn = node.querySelector(".kb-tree-toggle");
      if (btn) btn.setAttribute("aria-expanded", String(nextOpen));
    };
    const treeScope = document.querySelector("[data-share-panel='tree']") || document;
    const toggleAll = (nextOpen) => {
      const nodes = treeScope.querySelectorAll(".kb-tree-node[data-tree-key]");
      if (!nodes.length) return;
      nodes.forEach((node) => {
        if (!node.querySelector(".kb-tree-toggle")) return;
        toggleNode(node, nextOpen);
      });
      syncState();
    };
    const applyState = () => {
      const openKeys = readState();
      if (!openKeys.size) return;
      document.querySelectorAll(".kb-tree-node[data-tree-key]").forEach((node) => {
        if (!node.querySelector(".kb-tree-toggle")) return;
        const key = node.dataset.treeKey || "";
        if (!key) return;
        toggleNode(node, openKeys.has(key));
      });
    };
    toggles.forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        const node = btn.closest(".kb-tree-node");
        if (!node) return;
        const nextOpen = !node.classList.contains("is-open");
        toggleNode(node, nextOpen);
        syncState();
      });
    });
    document.querySelectorAll(".kb-tree-folder").forEach((label) => {
      label.addEventListener("click", () => {
        const node = label.closest(".kb-tree-node");
        if (!node || !node.querySelector(".kb-tree-toggle")) return;
        const nextOpen = !node.classList.contains("is-open");
        toggleNode(node, nextOpen);
        syncState();
      });
    });
    const collapseBtn = document.querySelector("[data-tree-collapse]");
    if (collapseBtn) {
      collapseBtn.addEventListener("click", (event) => {
        event.preventDefault();
        toggleAll(false);
      });
    }
    const expandBtn = document.querySelector("[data-tree-expand]");
    if (expandBtn) {
      expandBtn.addEventListener("click", (event) => {
        event.preventDefault();
        toggleAll(true);
      });
    }
    applyState();
  };

  const initDocTreeScroll = () => {
    const sidebar = document.querySelector(".kb-side-body");
    if (!sidebar) return;
    const active = sidebar.querySelector(".kb-tree-item.is-active");
    if (!active) return;
    const sidebarRect = sidebar.getBoundingClientRect();
    const itemRect = active.getBoundingClientRect();
    if (itemRect.top >= sidebarRect.top && itemRect.bottom <= sidebarRect.bottom) {
      return;
    }
    const offset = itemRect.top - sidebarRect.top - sidebar.clientHeight / 3;
    sidebar.scrollTo({top: sidebar.scrollTop + offset, behavior: "smooth"});
  };

  const initShareToc = () => {
    const containers = Array.from(
      document.querySelectorAll("[data-share-toc]"),
    );
    if (!containers.length) return;

    const normalizeId = (text) => {
      const raw = String(text || "").trim().toLowerCase();
      const base = raw
        .replace(/\s+/g, "-")
        .replace(/[^\w\-\u4e00-\u9fff]+/g, "")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "");
      return base;
    };

    const ensureHeadingId = (heading, index) => {
      if (heading.id) return heading.id;
      const base = normalizeId(heading.textContent || "") || `section-${index + 1}`;
      let nextId = base;
      let counter = 1;
      while (document.getElementById(nextId)) {
        nextId = `${base}-${counter}`;
        counter += 1;
      }
      heading.id = nextId;
      return nextId;
    };

    const isFootnoteHeading = (heading, separator) => {
      if (!heading) return false;
      if (heading.closest(".footnotes")) return true;
      if (heading.closest(".markdown-footnotes")) return true;
      if (!separator) return false;
      return Boolean(separator.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING);
    };

    const buildTree = (headings, section) => {
      const root = {level: 0, children: []};
      const stack = [root];
      headings.forEach((heading, index) => {
        const level = Number(String(heading.tagName || "H2").slice(1)) || 2;
        const node = {
          heading,
          level,
          id: ensureHeadingId(heading, index),
          section,
          children: [],
        };
        while (stack.length > 1 && level <= stack[stack.length - 1].level) {
          stack.pop();
        }
        stack[stack.length - 1].children.push(node);
        stack.push(node);
      });
      return root.children;
    };

    const renderTree = (
      nodes,
      level = 0,
      section = "main",
      baseLevel = 1,
      footnoteMeta = null,
    ) => {
      const list = document.createElement("ul");
      list.className = "share-toc-list";
      if (section === "footnotes") {
        list.classList.add("share-toc-list--footnotes");
      }
      list.dataset.level = String(level);
      if (level > 0) list.classList.add("share-toc-children");
      nodes.forEach((node) => {
        const item = document.createElement("li");
        item.className = "share-toc-node";
        if (section === "footnotes") {
          item.classList.add("is-footnote");
        }
        const hasChildren = node.children.length > 0;

        const row = document.createElement("div");
        row.className = "share-toc-row";
        row.dataset.section = section;
        const indent = Math.max(0, level);
        row.style.setProperty("--toc-abs-indent", `${indent * 20}px`);

        const link = document.createElement("a");
        link.className = "share-toc-link";
        if (section === "footnotes") {
          link.classList.add("share-toc-link--footnote");
        }
        link.href = `#${node.id}`;
        link.setAttribute("draggable", "false");

        const levelBadge = document.createElement("span");
        levelBadge.className = "share-toc-level";
        levelBadge.textContent = "H";
        const levelNum = document.createElement("span");
        levelNum.className = "share-toc-level-num";
        levelNum.textContent = String(node.level);
        levelBadge.appendChild(levelNum);
        link.appendChild(levelBadge);

        const linkText = document.createElement("span");
        linkText.className = "share-toc-text";
        linkText.textContent = node.heading.textContent || "未命名";

        if (section === "footnotes" && footnoteMeta) {
          const meta = footnoteMeta.get(node.heading);
          if (meta && meta.index) {
            link.dataset.footnoteIndex = String(meta.index);
            const backref = meta.backref || `#fnref${meta.index}`;
            link.dataset.footnoteBackref = backref;
            const sup = document.createElement("sup");
            sup.className = "share-toc-footnote-index";
            sup.textContent = `[${meta.index}]`;
            sup.setAttribute("role", "link");
            sup.tabIndex = 0;
            sup.dataset.footnoteIndex = String(meta.index);
            sup.dataset.footnoteBackref = backref;
            linkText.appendChild(sup);
          }
        }
        link.appendChild(linkText);
        row.appendChild(link);
        item.appendChild(row);

        if (hasChildren) {
          item.appendChild(
            renderTree(node.children, level + 1, section, baseLevel, footnoteMeta),
          );
        }
        list.appendChild(item);
      });
      return list;
    };

    containers.forEach((container) => {
      const prevCleanup = tocCleanupMap.get(container);
      if (typeof prevCleanup === "function") {
        prevCleanup();
        tocCleanupMap.delete(container);
      }
      const targetId = container.getAttribute("data-share-toc") || "";
      const target = document.querySelector(
        `.markdown-body[data-md-id="${targetId}"]`,
      );
      const body =
        container.querySelector(".share-toc-body") || container;
      const scrollBox = body;
      const ensureVisible = (element) => {
        if (!scrollBox || !element) return;
        const box = scrollBox.getBoundingClientRect();
        const rect = element.getBoundingClientRect();
        if (rect.top >= box.top && rect.bottom <= box.bottom) {
          return;
        }
        const offset = rect.top - box.top - 24;
        scrollBox.scrollTo({
          top: scrollBox.scrollTop + offset,
          behavior: "smooth",
        });
      };
      body.innerHTML = "";
      if (!target) return;

      const separator = target.querySelector("hr.footnotes-sep");
      const allHeadings = Array.from(
        target.querySelectorAll("h1, h2, h3, h4, h5, h6"),
      );
      if (!allHeadings.length) {
        const empty = document.createElement("div");
        empty.className = "share-toc-empty";
        empty.textContent = "暂无目录";
        body.appendChild(empty);
        return;
      }

      const headingLevels = allHeadings
        .map((heading) => Number(String(heading.tagName || "H2").slice(1)) || 2)
        .filter((level) => Number.isFinite(level));
      const baseLevel = headingLevels.length ? Math.min(...headingLevels) : 1;
      const footnoteMeta = new Map();
      container.classList.add("share-toc--abs");

      const mainHeadings = [];
      const footnoteHeadings = [];
      allHeadings.forEach((heading) => {
        if (isFootnoteHeading(heading, separator)) {
          footnoteHeadings.push(heading);
          const item = heading.closest(
            ".footnotes li[id], .markdown-footnotes li[id]",
          );
          const list = item?.closest?.("ol");
          let index = 0;
          if (item && list) {
            const siblings = Array.from(list.children || []);
            index = siblings.indexOf(item) + 1;
          }
          let backref = "";
          const backrefEl = item?.querySelector?.(
            ".footnote-backref, [data-footnote-backref], a[href^=\"#fnref\"]",
          );
          if (backrefEl) backref = backrefEl.getAttribute("href") || "";
          if (index > 0) {
            footnoteMeta.set(heading, {index, backref});
          }
        } else {
          mainHeadings.push(heading);
        }
      });
      const headings = [...mainHeadings, ...footnoteHeadings];
      if (!headings.length) {
        const empty = document.createElement("div");
        empty.className = "share-toc-empty";
        empty.textContent = "暂无目录";
        body.appendChild(empty);
        return;
      }

      if (mainHeadings.length) {
        const nodes = buildTree(mainHeadings, "main");
        const list = renderTree(nodes, 0, "main", baseLevel, footnoteMeta);
        body.appendChild(list);
      }

      if (footnoteHeadings.length) {
        if (mainHeadings.length) {
          const divider = document.createElement("div");
          divider.className = "share-toc-divider";
          divider.setAttribute("aria-hidden", "true");
          body.appendChild(divider);
        }
        const nodes = buildTree(footnoteHeadings, "footnotes");
        const list = renderTree(nodes, 0, "footnotes", baseLevel, footnoteMeta);
        body.appendChild(list);
      }


      const scrollToElementWithOffset = (element) => {
        if (!element) return;
        const raw = window.getComputedStyle(element).scrollMarginTop;
        const marginTop = Number.parseFloat(raw || "0");
        const baseOffset = document.body.classList.contains("layout-share") ? 120 : 0;
        const offset = Math.max(baseOffset, Number.isFinite(marginTop) ? marginTop : 0);
        const top = element.getBoundingClientRect().top + window.scrollY - offset;
        window.scrollTo({top, behavior: "smooth"});
      };

      const jumpToBackref = (href) => {
        if (!href) return null;
        if (href.startsWith("#")) {
          const id = href.slice(1);
          const targetEl = document.getElementById(id);
          if (targetEl) {
            scrollToElementWithOffset(targetEl);
            history.replaceState(null, "", href);
            return targetEl;
          }
        }
        window.location.href = href;
        return null;
      };

      const onFootnoteJump = (event) => {
        const sup = event.target?.closest?.(".share-toc-footnote-index");
        if (!sup) return;
        const href = sup.dataset.footnoteBackref || "";
        if (!href) return;
        event.preventDefault();
        event.stopPropagation();
        const targetEl = jumpToBackref(href);
        if (targetEl) {
          activeLock.id = "";
          activeLock.target = targetEl;
          activeLock.until = Date.now() + 2000;
          scheduleActiveByElement(targetEl);
        }
      };

      const onFootnoteKey = (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        const sup = event.target?.closest?.(".share-toc-footnote-index");
        if (!sup) return;
        const href = sup.dataset.footnoteBackref || "";
        if (!href) return;
        event.preventDefault();
        event.stopPropagation();
        const targetEl = jumpToBackref(href);
        if (targetEl) {
          activeLock.id = "";
          activeLock.target = targetEl;
          activeLock.until = Date.now() + 2000;
          scheduleActiveByElement(targetEl);
        }
      };


      const onContentLinkClick = (event) => {
        const anchor = event.target?.closest?.("a");
        if (!anchor) return;
        const href = anchor.getAttribute("href") || "";
        if (!href.startsWith("#fn")) return;
        if (href.startsWith("#fnref")) return;
        const id = href.slice(1);
        const targetEl = document.getElementById(id);
        if (!targetEl) return;
        event.preventDefault();
        scrollToElementWithOffset(targetEl);
        history.replaceState(null, "", href);
        const index =
          parseFootnoteIndex(href) || findFootnoteIndexForElement(targetEl);
        if (setActiveByFootnoteIndex(index)) {
          activeLock.target = targetEl;
          activeLock.until = Date.now() + 2400;
        }
        scheduleActiveByElement(targetEl);
      };

      const onContentBackrefClick = (event) => {
        const anchor = event.target?.closest?.("a");
        if (!anchor) return;
        const href = anchor.getAttribute("href") || "";
        if (!href.startsWith("#fnref")) return;
        const id = href.slice(1);
        const targetEl = document.getElementById(id);
        if (!targetEl) return;
        event.preventDefault();
        scrollToElementWithOffset(targetEl);
        history.replaceState(null, "", href);
        activeLock.id = "";
        activeLock.target = targetEl;
        activeLock.until = Date.now() + 2000;
        scheduleActiveByElement(targetEl);
      };

      const onHashChange = () => {
        const id = window.location.hash.replace(/^#/, "");
        if (!id) return;
        const targetEl = document.getElementById(id);
        if (!targetEl) return;
        scheduleActiveByElement(targetEl);
      };

      if (target) {
        target.addEventListener("click", onContentLinkClick);
        target.addEventListener("click", onContentBackrefClick);
      }
      window.addEventListener("hashchange", onHashChange);

      body.addEventListener("click", onFootnoteJump);
      body.addEventListener("keydown", onFootnoteKey);

      const dragState = {
        isDown: false,
        isDragging: false,
        startX: 0,
        scrollLeft: 0,
        suppressUntil: 0,
      };
      const dragThreshold = 3;

      const onMouseDown = (event) => {
        if (event.button !== 0) return;
        dragState.isDown = true;
        dragState.isDragging = false;
        dragState.startX = event.clientX;
        dragState.scrollLeft = scrollBox.scrollLeft;
      };

      const onMouseMove = (event) => {
        if (!dragState.isDown) return;
        const deltaX = event.clientX - dragState.startX;
        if (!dragState.isDragging && Math.abs(deltaX) >= dragThreshold) {
          dragState.isDragging = true;
        }
        if (dragState.isDragging) {
          scrollBox.scrollLeft = dragState.scrollLeft - deltaX;
        }
      };

      const stopDrag = () => {
        if (!dragState.isDown) return;
        dragState.isDown = false;
        if (dragState.isDragging) {
          dragState.suppressUntil = Date.now() + 250;
        }
        dragState.isDragging = false;
      };

      const onDragStart = (event) => {
        event.preventDefault();
      };
      const onClickCapture = (event) => {
        if (Date.now() < dragState.suppressUntil) {
          event.preventDefault();
          event.stopPropagation();
        }
      };

      scrollBox.addEventListener("mousedown", onMouseDown);
      scrollBox.addEventListener("mousemove", onMouseMove);
      scrollBox.addEventListener("mouseup", stopDrag);
      scrollBox.addEventListener("mouseleave", stopDrag);
      scrollBox.addEventListener("dragstart", onDragStart);
      scrollBox.addEventListener("click", onClickCapture, true);

      const linkMap = new Map();
      const activeLock = {
        id: "",
        until: 0,
        scrollEndTimer: 0,
        scrollTicking: false,
        scrollOffset: 0,
        target: null,
      };
      const setActiveLink = (link) => {
        body.querySelectorAll(".share-toc-link").forEach((item) => {
          item.classList.remove("is-active");
        });
        body.querySelectorAll(".share-toc-row").forEach((row) => {
          row.classList.remove("is-active");
        });
        if (link) {
          link.classList.add("is-active");
          const row = link.closest(".share-toc-row");
          if (row) row.classList.add("is-active");
        }
      };
      body.querySelectorAll(".share-toc-link").forEach((link) => {
        const href = link.getAttribute("href") || "";
        if (href.startsWith("#")) {
          linkMap.set(href.slice(1), link);
        }
      });

      const parseFootnoteIndex = (value) => {
        const raw = String(value || "").trim();
        if (!raw) return 0;
        const match = raw.match(/^#?fn(?:ref)?[:\-_]?(\d+)/i);
        if (match) return Number(match[1]) || 0;
        const num = Number(raw);
        return Number.isFinite(num) ? num : 0;
      };

      const isFnRefId = (value) => /^fnref[:\-_]?\d+/i.test(String(value || ""));

      const footnoteIndexToLink = new Map();
      body.querySelectorAll(".share-toc-link--footnote").forEach((link) => {
        const idx = parseFootnoteIndex(link.dataset.footnoteIndex || "");
        if (idx > 0 && !footnoteIndexToLink.has(idx)) {
          footnoteIndexToLink.set(idx, link);
        }
      });

      const footnoteItems = [];
      if (target) {
        const candidates = Array.from(
          target.querySelectorAll(".footnotes li[id], .markdown-footnotes li[id]"),
        );
        candidates.forEach((item, idx) => {
          let index = parseFootnoteIndex(item.dataset.footnoteIndex || item.id);
          if (!index) index = idx + 1;
          item.dataset.footnoteIndex = String(index);
          footnoteItems.push(item);
        });
      }

      const activeTargets = [];
      headings.forEach((heading) => {
        if (!heading?.id) return;
        activeTargets.push({type: "heading", element: heading, id: heading.id});
      });
      footnoteItems.forEach((item) => {
        const index = parseFootnoteIndex(item.dataset.footnoteIndex || item.id);
        if (!index) return;
        activeTargets.push({type: "footnote", element: item, index});
      });
      activeTargets.sort((a, b) => {
        if (a.element === b.element) return 0;
        const pos = a.element.compareDocumentPosition(b.element);
        if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
        if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
        return 0;
      });

      const findFootnoteIndexForElement = (element) => {
        if (!element) return 0;
        const item = element.closest?.(
          ".footnotes li[id], .markdown-footnotes li[id]",
        );
        if (item) {
          return parseFootnoteIndex(item.dataset.footnoteIndex || item.id);
        }
        const id = element.id || "";
        if (id && isFnRefId(id)) {
          return 0;
        }
        if (id) {
          return parseFootnoteIndex(id);
        }
        return 0;
      };

      const findHeadingForElement = (element) => {
        if (!element || !headings.length) return null;
        let chosen = null;
        headings.forEach((heading) => {
          if (!heading) return;
          if (heading === element) {
            chosen = heading;
            return;
          }
          const pos = heading.compareDocumentPosition(element);
          if (
            pos & Node.DOCUMENT_POSITION_FOLLOWING ||
            pos & Node.DOCUMENT_POSITION_CONTAINED_BY
          ) {
            chosen = heading;
          }
        });
        return chosen;
      };

      const setActiveByElement = (element) => {
        const footnoteIndex = findFootnoteIndexForElement(element);
        if (footnoteIndex && setActiveByFootnoteIndex(footnoteIndex)) {
          return;
        }
        const targetHeading = findHeadingForElement(element);
        if (!targetHeading) return;
        const link = linkMap.get(targetHeading.id);
        if (!link) return;
        activeLock.id = targetHeading.id;
        activeLock.until = Date.now() + 900;
        setActiveLink(link);
        ensureVisible(link);
      };

      const highlightByElement = (element) => {
        const footnoteIndex = findFootnoteIndexForElement(element);
        if (footnoteIndex) {
          const link = footnoteIndexToLink.get(footnoteIndex);
          if (link) {
            setActiveLink(link);
            ensureVisible(link);
            return true;
          }
        }
        const targetHeading = findHeadingForElement(element);
        if (!targetHeading) return false;
        const link = linkMap.get(targetHeading.id);
        if (!link) return false;
        setActiveLink(link);
        ensureVisible(link);
        return true;
      };

      const scheduleActiveByElement = (element) => {
        if (!element) return;
        requestAnimationFrame(() => {
          setTimeout(() => setActiveByElement(element), 40);
        });
      };

      const setActiveByFootnoteIndex = (index) => {
        if (!index) return false;
        const link = footnoteIndexToLink.get(index);
        if (!link) return false;
        const href = link.getAttribute("href") || "";
        if (href.startsWith("#")) {
          activeLock.id = href.slice(1);
          activeLock.until = Date.now() + 900;
        }
        setActiveLink(link);
        ensureVisible(link);
        return true;
      };

      body.querySelectorAll(".share-toc-link").forEach((link) => {
        link.addEventListener("click", (event) => {
          if (Date.now() < dragState.suppressUntil) {
            event.preventDefault();
            return;
          }
          const href = link.getAttribute("href") || "";
          if (!href.startsWith("#")) return;
          const target = document.getElementById(href.slice(1));
          if (!target) return;
          event.preventDefault();
          activeLock.id = target.id;
          activeLock.until = Date.now() + 1200;
          target.scrollIntoView({behavior: "smooth", block: "start"});
          history.replaceState(null, "", href);
          setActiveLink(link);
          ensureVisible(link);
        });
      });

      const getScrollOffset = () => {
        const sample = headings[0];
        if (!sample) return 0;
        const raw = window.getComputedStyle(sample).scrollMarginTop;
        const value = Number.parseFloat(raw || "0");
        if (Number.isFinite(value) && value > 0) return value;
        return document.body.classList.contains("layout-share") ? 120 : 0;
      };
      activeLock.scrollOffset = getScrollOffset();
      const activeThreshold = 8;

      const pickActiveTarget = () => {
        if (!activeTargets.length) return null;
        const offset = activeLock.scrollOffset || 0;
        let current = null;
        for (const target of activeTargets) {
          const top = target.element.getBoundingClientRect().top;
          if (top - offset <= activeThreshold) {
            current = target;
          } else {
            break;
          }
        }
        return current;
      };

      const updateActiveByScroll = () => {
        if (activeLock.target) {
          const now = Date.now();
          const offset = activeLock.scrollOffset || 0;
          const distance = Math.abs(
            activeLock.target.getBoundingClientRect().top - offset,
          );
          const shouldUnlock =
            now >= activeLock.until ||
            (Number.isFinite(distance) && distance <= activeThreshold);
          if (shouldUnlock) {
            activeLock.target = null;
          } else {
            if (highlightByElement(activeLock.target)) {
              return;
            }
          }
        }
        if (activeLock.id) {
          if (Date.now() < activeLock.until) {
            const locked = linkMap.get(activeLock.id);
            if (locked) {
              setActiveLink(locked);
              ensureVisible(locked);
              return;
            }
          }
          activeLock.id = "";
          activeLock.until = 0;
        }

        const activeTarget = pickActiveTarget();
        if (!activeTarget) return;
        if (activeTarget.type === "footnote") {
          if (setActiveByFootnoteIndex(activeTarget.index)) {
            return;
          }
          const fallback = findHeadingForElement(activeTarget.element);
          if (!fallback) return;
          const fallbackLink = linkMap.get(fallback.id);
          if (!fallbackLink) return;
          setActiveLink(fallbackLink);
          ensureVisible(fallbackLink);
          return;
        }

        const link = linkMap.get(activeTarget.id);
        if (!link) return;
        setActiveLink(link);
        ensureVisible(link);
      };

      const onScroll = () => {
        if (!activeLock.scrollTicking) {
          activeLock.scrollTicking = true;
          requestAnimationFrame(() => {
            activeLock.scrollTicking = false;
            updateActiveByScroll();
          });
        }
        clearTimeout(activeLock.scrollEndTimer);
        activeLock.scrollEndTimer = window.setTimeout(() => {
          updateActiveByScroll();
        }, 160);
      };

      const scrollOpts = {passive: true};
      const onResize = () => {
        activeLock.scrollOffset = getScrollOffset();
        updateActiveByScroll();
      };
      window.addEventListener("scroll", onScroll, scrollOpts);
      window.addEventListener("resize", onResize);
      updateActiveByScroll();

      tocCleanupMap.set(container, () => {
        scrollBox.removeEventListener("mousedown", onMouseDown);
        scrollBox.removeEventListener("mousemove", onMouseMove);
        scrollBox.removeEventListener("mouseup", stopDrag);
        scrollBox.removeEventListener("mouseleave", stopDrag);
        scrollBox.removeEventListener("dragstart", onDragStart);
        scrollBox.removeEventListener("click", onClickCapture, true);
        window.removeEventListener("scroll", onScroll, scrollOpts);
        window.removeEventListener("resize", onResize);
        body.removeEventListener("click", onFootnoteJump);
        body.removeEventListener("keydown", onFootnoteKey);
        if (target) {
          target.removeEventListener("click", onContentLinkClick);
          target.removeEventListener("click", onContentBackrefClick);
        }
        window.removeEventListener("hashchange", onHashChange);

      });
    });
  };

  const initShareSidebarTabs = () => {
    const tabs = document.querySelector("[data-share-tabs]");
    if (!tabs) return;
    const buttons = Array.from(tabs.querySelectorAll("[data-share-tab]"));
    if (!buttons.length) return;
    const container = tabs.closest("[data-share-sidebar]") || document;
    const panels = Array.from(container.querySelectorAll("[data-share-panel]"));
    if (!panels.length) return;
    const treeActions =
      tabs.querySelector("[data-share-tree-actions]") ||
      container.querySelector("[data-share-tree-actions]");
    const defaultTab =
      tabs.getAttribute("data-share-default") ||
      buttons[0]?.dataset.shareTab ||
      "tree";
    const setActive = (tab) => {
      buttons.forEach((btn) => {
        const isActive = (btn.dataset.shareTab || "") === tab;
        btn.classList.toggle("is-active", isActive);
        btn.setAttribute("aria-selected", isActive ? "true" : "false");
      });
      panels.forEach((panel) => {
        panel.hidden = (panel.dataset.sharePanel || "") !== tab;
      });
      if (treeActions) {
        treeActions.hidden = tab !== "tree";
      }
    };
    buttons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.dataset.shareTab || "";
        if (!tab) return;
        setActive(tab);
      });
    });
    setActive(defaultTab);
  };

  const initShareDrawer = () => {
    const openBtn = document.querySelector("[data-share-drawer-open]");
    const backdrop = document.querySelector("[data-share-drawer-close]");
    const sidebar = document.querySelector(".kb-sidebar, .share-toc");
    if (openBtn && !sidebar) {
      openBtn.hidden = true;
    }
    if (!openBtn && !backdrop) return;
    const setOpen = (open) => {
      document.body.classList.toggle("share-side-open", open);
    };
    if (openBtn) {
      openBtn.addEventListener("click", () => {
        const isOpen = document.body.classList.contains("share-side-open");
        setOpen(!isOpen);
      });
    }
    if (backdrop) {
      backdrop.addEventListener("click", () => setOpen(false));
    }
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") setOpen(false);
    });
    document.querySelectorAll(".kb-sidebar a, .share-toc a").forEach((link) => {
      link.addEventListener("click", () => setOpen(false));
    });
    if (openBtn && sidebar) {
      const mq = window.matchMedia("(max-width: 960px)");
      const updateTrigger = () => {
        const pos = window.getComputedStyle(sidebar).position;
        const shouldShow = mq.matches || pos === "fixed";
        openBtn.hidden = !shouldShow;
        openBtn.style.display = shouldShow ? "inline-flex" : "none";
      };
      if (typeof mq.addEventListener === "function") {
        mq.addEventListener("change", updateTrigger);
      } else if (typeof mq.addListener === "function") {
        mq.addListener(updateTrigger);
      }
      window.addEventListener("resize", updateTrigger, {passive: true});
      window.addEventListener("orientationchange", updateTrigger, {passive: true});
      requestAnimationFrame(updateTrigger);
      setTimeout(updateTrigger, 300);
    }
  };

  const initShareDocNavigation = () => {
    if (shareNavReady) return;
    if (!document.body.classList.contains("layout-share")) return;
    const container = document.querySelector(".share-shell");
    if (!container) return;
    shareNavReady = true;

    let requestId = 0;
    let controller = null;

    const cssEscape =
      (window.CSS && typeof window.CSS.escape === "function" && window.CSS.escape) ||
      ((value) => String(value || "").replace(/[^a-zA-Z0-9_-]/g, "\\$&"));

    const setActiveDoc = (docId) => {
      document.querySelectorAll(".kb-tree-item.is-active").forEach((item) => {
        item.classList.remove("is-active");
      });
      if (!docId) return;
      const selector = `.kb-tree-item[data-doc-id="${cssEscape(docId)}"]`;
      const active = document.querySelector(selector);
      if (active) active.classList.add("is-active");
    };

    const replaceMain = (html) => {
      const shell = document.querySelector(".share-shell");
      const main = shell?.querySelector(".kb-main");
      if (!shell || !main || !html) return null;
      const wrapper = document.createElement("div");
      wrapper.innerHTML = html;
      const nextMain = wrapper.firstElementChild;
      if (!nextMain) return null;
      main.replaceWith(nextMain);
      return nextMain;
    };

    const updateAfterLoad = (payload, url, pushState) => {
      if (payload?.html) {
        replaceMain(payload.html);
      }
      if (container) {
        container.dataset.shareDocId = payload?.docId || "";
      }
      if (payload?.title) {
        document.title = payload.title;
      }
      if (pushState) {
        history.pushState({spsDocId: payload?.docId || ""}, "", url);
      } else {
        history.replaceState({spsDocId: payload?.docId || ""}, "", url);
      }
      setActiveDoc(payload?.docId || "");
      const hash = url.includes("#") ? url.slice(url.indexOf("#")) : "";
      if (hash) {
        const target = document.getElementById(hash.slice(1));
        if (target) {
          target.scrollIntoView({behavior: "auto", block: "start"});
        }
      } else {
        window.scrollTo({top: 0, behavior: "auto"});
      }
      refreshShareDynamicContent();
    };

    const loadDoc = async (url, {pushState = true} = {}) => {
      const currentId = ++requestId;
      if (controller) controller.abort();
      controller = new AbortController();
      const main = document.querySelector(".kb-main");
      if (main) main.classList.add("is-loading");
      try {
        const targetUrl = new URL(url, window.location.href);
        targetUrl.searchParams.set("partial", "1");
        const resp = await fetch(targetUrl.toString(), {
          method: "GET",
          headers: {"X-SPS-Partial": "1"},
          credentials: "same-origin",
          signal: controller.signal,
        });
        const payload = await resp.json().catch(() => null);
        if (!resp.ok || !payload || payload.code !== 0 || !payload.data?.html) {
          throw new Error(payload?.msg || "Failed to load doc.");
        }
        if (currentId !== requestId) return;
        updateAfterLoad(payload.data, url, pushState);
      } catch (err) {
        if (err?.name === "AbortError") return;
        window.location.href = url;
      } finally {
        const latestMain = document.querySelector(".kb-main");
        if (latestMain) latestMain.classList.remove("is-loading");
      }
    };

    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!target) return;
      const link = target.closest("a[data-share-nav='doc']");
      if (!link) return;
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const href = link.getAttribute("href");
      if (!href) return;
      if (link.getAttribute("target") === "_blank") return;
      const url = new URL(href, window.location.href);
      if (url.origin !== window.location.origin) return;
      event.preventDefault();
      loadDoc(url.toString(), {pushState: true});
    });

    window.addEventListener("popstate", () => {
      if (!document.body.classList.contains("layout-share")) return;
      loadDoc(window.location.href, {pushState: false});
    });
  };

  const initShareMarkdownToggle = () => {
    if (!document.body.classList.contains("layout-share")) return;
    document.querySelectorAll("[data-share-toggle]").forEach((btn) => {
      if (btn.dataset.shareToggleBound === "1") return;
      btn.dataset.shareToggleBound = "1";
      btn.addEventListener("click", () => {
        const container = btn.closest(".share-article");
        if (!container) return;
        const isMarkdown = container.classList.toggle("is-markdown");
        container.setAttribute("data-share-view", isMarkdown ? "markdown" : "preview");
        btn.textContent = isMarkdown ? "预览" : "源码";
        btn.setAttribute("aria-pressed", isMarkdown ? "true" : "false");
      });
    });
  };

  const initAppDrawer = () => {
    const openBtn = document.querySelector("[data-app-drawer-open]");
    const backdrop = document.querySelector("[data-app-drawer-close]");
    const sidebar = document.querySelector(".app-sidebar");
    if (!sidebar) return;
    const setOpen = (open) => {
      document.body.classList.toggle("app-side-open", open);
    };
    if (openBtn) {
      openBtn.addEventListener("click", () => {
        const isOpen = document.body.classList.contains("app-side-open");
        setOpen(!isOpen);
      });
    }
    if (backdrop) {
      backdrop.addEventListener("click", () => setOpen(false));
    }
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") setOpen(false);
    });
    document.querySelectorAll(".app-sidebar a").forEach((link) => {
      link.addEventListener("click", () => setOpen(false));
    });
    const mq = window.matchMedia("(max-width: 960px)");
    const updateTrigger = () => {
      const shouldShow = mq.matches;
      if (openBtn) {
        openBtn.hidden = !shouldShow;
        openBtn.style.display = shouldShow ? "inline-flex" : "none";
      }
      if (!shouldShow) {
        setOpen(false);
      }
    };
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", updateTrigger);
    } else if (typeof mq.addListener === "function") {
      mq.addListener(updateTrigger);
    }
    window.addEventListener("resize", updateTrigger, {passive: true});
    window.addEventListener("orientationchange", updateTrigger, {passive: true});
    requestAnimationFrame(updateTrigger);
  };

  const initScrollTop = () => {
    const btn = document.querySelector("[data-scroll-top]");
    if (!btn) return;
    const toggle = () => {
      btn.classList.toggle("is-visible", window.scrollY > 320);
    };
    btn.addEventListener("click", () => {
      window.scrollTo({top: 0, behavior: "smooth"});
    });
    window.addEventListener("scroll", toggle, {passive: true});
    toggle();
  };

  const initLoginTabs = () => {
    const tabs = document.querySelector("[data-login-tabs]");
    if (!tabs) return;
    const buttons = Array.from(tabs.querySelectorAll("[data-login-tab]"));
    const panels = Array.from(document.querySelectorAll("[data-login-panel]"));
    if (!buttons.length || !panels.length) return;
    const defaultTab = tabs.getAttribute("data-login-default") || buttons[0].dataset.loginTab || "password";
    const setActive = (tab) => {
      buttons.forEach((btn) => {
        const isActive = (btn.dataset.loginTab || "") === tab;
        btn.classList.toggle("is-active", isActive);
        btn.setAttribute("aria-selected", isActive ? "true" : "false");
      });
      panels.forEach((panel) => {
        panel.hidden = (panel.dataset.loginPanel || "") !== tab;
      });
    };
    buttons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.dataset.loginTab || "";
        if (!tab) return;
        setActive(tab);
      });
    });
    setActive(defaultTab);
  };

  const initCountdownButtons = () => {
    const buttons = Array.from(document.querySelectorAll("[data-countdown-until]"));
    if (!buttons.length) return;
    buttons.forEach((btn) => {
      const until = Number(btn.dataset.countdownUntil || 0);
      if (!Number.isFinite(until)) return;
      const baseText = btn.dataset.countdownText || btn.textContent || "";
      const tick = () => {
        const remaining = Math.max(0, until - Date.now());
        if (remaining <= 0) {
          btn.disabled = false;
          btn.textContent = baseText;
          return;
        }
        const seconds = Math.ceil(remaining / 1000);
        btn.disabled = true;
        btn.textContent = `${baseText} (${seconds}s)`;
        window.setTimeout(tick, 1000);
      };
      tick();
    });
  };

  const initBatchSelection = () => {
    const groups = new Map();
    document.querySelectorAll("[data-check-item]").forEach((item) => {
      const group = item.dataset.checkItem || "";
      if (!group) return;
      if (!groups.has(group)) groups.set(group, {items: [], toggles: []});
      groups.get(group).items.push(item);
    });
    document.querySelectorAll("[data-check-all]").forEach((toggle) => {
      const group = toggle.dataset.checkAll || "";
      if (!group) return;
      if (!groups.has(group)) groups.set(group, {items: [], toggles: []});
      groups.get(group).toggles.push(toggle);
    });

    groups.forEach(({items, toggles}) => {
      if (!items.length || !toggles.length) return;
      const sync = () => {
        const selectable = items.filter((item) => !item.disabled);
        const allChecked = selectable.length
          ? selectable.every((item) => item.checked)
          : false;
        toggles.forEach((toggle) => {
          toggle.checked = allChecked;
        });
      };
      toggles.forEach((toggle) => {
        toggle.addEventListener("change", () => {
          items.forEach((item) => {
            if (!item.disabled) item.checked = toggle.checked;
          });
          sync();
        });
      });
      items.forEach((item) => item.addEventListener("change", sync));
      sync();
    });
  };

  const initUserModal = () => {
    const modal = document.querySelector("[data-user-modal]");
    if (!modal) return;
    const close = () => {
      modal.hidden = true;
    };
    modal.addEventListener("click", (event) => {
      const target = event.target;
      if (
        target &&
        (target.matches("[data-modal-close]") ||
          target.classList.contains("modal-backdrop"))
      ) {
        close();
      }
    });
    document.querySelectorAll("[data-user-edit]").forEach((btn) => {
      btn.addEventListener("click", () => {
        modal.hidden = false;
        const dataset = btn.dataset;
        modal.querySelector("[data-user-field='id']").value =
          dataset.userId || "";
        modal.querySelector("[data-user-field='username']").value =
          dataset.userName || "";
        modal.querySelector("[data-user-field='email']").value =
          dataset.userEmail || "";
        modal.querySelector("[data-user-field='role']").value =
          dataset.userRole || "user";
        modal.querySelector("[data-user-field='disabled']").value =
          dataset.userDisabled || "0";
        modal.querySelector("[data-user-field='limit']").value =
          dataset.userLimit || "0";
      });
    });
  };

  const parseChartPayload = (raw) => {
    if (!raw) return null;
    try {
      const payload = JSON.parse(raw);
      if (!payload || !Array.isArray(payload.labels) || !Array.isArray(payload.series)) {
        return null;
      }
      return payload;
    } catch (error) {
      return null;
    }
  };

  const formatBytes = (bytes) => {
    const value = Number(bytes);
    if (!Number.isFinite(value)) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let size = Math.max(0, value);
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex += 1;
    }
    const fixed = size >= 100 ? 0 : size >= 10 ? 1 : 2;
    return `${size.toFixed(fixed)} ${units[unitIndex]}`;
  };

  const formatNumber = (value) => {
    const num = Math.round(Number(value) || 0);
    return num.toLocaleString();
  };

  const computeNiceScale = (maxValue, tickCount = 4, minStep = 0) => {
    const safeMax = maxValue > 0 ? maxValue : 1;
    const roughStep = safeMax / Math.max(1, tickCount - 1);
    const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
    const candidates = [1, 2, 5, 10];
    let step = magnitude;
    for (const candidate of candidates) {
      const next = candidate * magnitude;
      if (roughStep <= next) {
        step = next;
        break;
      }
    }
    if (minStep > 0 && step < minStep) {
      step = minStep;
    }
    const maxTick = Math.ceil(safeMax / step) * step;
    return { step, maxTick };
  };

  const buildTicks = (maxValue, unit) => {
    const minStep = unit === "count" ? 1 : 0;
    const { step, maxTick } = computeNiceScale(maxValue, 4, minStep);
    const ticks = [];
    for (let val = 0; val <= maxTick + step / 2; val += step) {
      ticks.push(Number(val.toFixed(6)));
    }
    const deduped = [];
    let lastLabel = null;
    ticks.forEach((tick) => {
      const label = formatAxisValue(tick, unit);
      if (label !== lastLabel) {
        deduped.push(tick);
        lastLabel = label;
      }
    });
    if (!deduped.length) {
      deduped.push(0, maxTick);
    }
    return { ticks: deduped, maxTick };
  };

  const formatAxisValue = (value, unit) => {
    if (unit === "MB") {
      let fixed = 1;
      if (value >= 10) fixed = 0;
      else if (value >= 1) fixed = 1;
      else if (value >= 0.1) fixed = 2;
      else fixed = 3;
      return Number(value).toFixed(fixed);
    }
    return formatNumber(value);
  };

  const buildChartPaths = (values, width, height, padding, maxValue) => {
    const count = values.length;
    if (!count) return { line: "", area: "" };
    const step = count > 1 ? (width - padding.left - padding.right) / (count - 1) : 0;
    const points = values.map((val, index) => {
      const ratio = maxValue > 0 ? val / maxValue : 0;
      const x = padding.left + step * index;
      const y = padding.top + (1 - ratio) * (height - padding.top - padding.bottom);
      return [x, y];
    });
    const line = `M ${points.map((pt) => `${pt[0].toFixed(2)} ${pt[1].toFixed(2)}`).join(" L ")}`;
    const areaPoints = [
      ...points,
      [padding.left + step * (count - 1), height - padding.bottom],
      [padding.left, height - padding.bottom],
    ];
    const area = `M ${areaPoints
      .map((pt) => `${pt[0].toFixed(2)} ${pt[1].toFixed(2)}`)
      .join(" L ")} Z`;
    return { line, area };
  };

  const resolveCssVar = (name, fallback) => {
    const value = getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim();
    return value || fallback;
  };

  const getChartColorMap = () => {
    const primary = resolveCssVar("--primary", "#5a7bff");
    const accent = resolveCssVar("--accent", "#1aa7a1");
    return {
      line: {
        "chart-line--primary": primary,
        "chart-line--accent": accent,
        "chart-line--secondary": "#f29b6e",
        "chart-line--info": "#6c8bff",
        "chart-line--storage": "#2ea7b0",
      },
      area: {
        "chart-area--primary": "rgba(90, 123, 255, 0.25)",
        "chart-area--secondary": "rgba(242, 155, 110, 0.24)",
        "chart-area--info": "rgba(108, 139, 255, 0.2)",
        "chart-area--storage": "rgba(46, 167, 176, 0.22)",
      },
    };
  };

  const resolveClassColor = (className, palette) => {
    if (!className) return "";
    const entry = Object.keys(palette).find((key) => className.includes(key));
    return entry ? palette[entry] : "";
  };

  const renderAdminChartSvg = (payload) => {
    const labels = payload.labels || [];
    const seriesList = payload.series || [];
    const unit = payload.unit || "count";
    const width = 360;
    const height = 220;
    const padding = { top: 14, right: 6, bottom: 26, left: 12 };
    const colors = getChartColorMap();
    const safeFont = "'Noto Sans SC','Outfit','Microsoft YaHei',sans-serif";
    const axisFontSize = 9;
    const axisFontWeight = 400;
    let maxValue = 0;
    seriesList.forEach((series) => {
      (series.values || []).forEach((value) => {
        maxValue = Math.max(maxValue, Number(value) || 0);
      });
    });
    const { ticks, maxTick } = buildTicks(maxValue, unit);
    const previewLabels = ticks.map((tick) => formatAxisValue(tick, unit));
    const maxLabelLen = previewLabels.reduce(
      (max, label) => Math.max(max, String(label).length),
      0,
    );
    const labelWidth = Math.max(20, maxLabelLen * 6 + 6);
    const dynamicPadding = {
      top: padding.top,
      right: padding.right,
      bottom: padding.bottom,
      left: Math.max(padding.left, labelWidth),
    };
    const maxXTicks = labels.length <= 7 ? labels.length : 5;
    const xStep = Math.max(1, Math.ceil((labels.length - 1) / Math.max(1, maxXTicks - 1)));
    const tickIndexes = new Set([0, labels.length - 1]);
    for (let i = 0; i < labels.length; i += xStep) {
      tickIndexes.add(i);
    }
    const xTickList = Array.from(tickIndexes).filter((idx) => idx >= 0 && idx < labels.length);
    xTickList.sort((a, b) => a - b);
    const formatDateLabel = (label) => {
      if (typeof label !== "string") return "";
      return label.length >= 10 ? label.slice(5) : label;
    };

    const gridLines = ticks.slice(1).map((tick) => {
      const y =
        dynamicPadding.top +
        (1 - tick / maxTick) *
          (height - dynamicPadding.top - dynamicPadding.bottom);
      return `<line x1="${dynamicPadding.left}" y1="${y.toFixed(
        2,
      )}" x2="${(width - dynamicPadding.right).toFixed(2)}" y2="${y.toFixed(
        2,
      )}"></line>`;
    });

    const axisLabels = [
      ...ticks.map((tick) => {
        const y =
          dynamicPadding.top +
          (1 - tick / maxTick) *
            (height - dynamicPadding.top - dynamicPadding.bottom);
        return `<text x="${Math.max(6, dynamicPadding.left - 6).toFixed(
          2,
        )}" y="${y.toFixed(
          2,
        )}" text-anchor="end" dominant-baseline="middle" font-family="${safeFont}" font-size="${axisFontSize}" font-weight="${axisFontWeight}">${formatAxisValue(
          tick,
          unit,
        )}</text>`;
      }),
      ...xTickList.map((idx) => {
        const x =
          labels.length > 1
            ? dynamicPadding.left +
              (idx / (labels.length - 1)) *
                (width - dynamicPadding.left - dynamicPadding.right)
            : dynamicPadding.left;
        const anchor =
          idx === 0 ? "start" : idx === labels.length - 1 ? "end" : "middle";
        return `<text x="${x.toFixed(
          2,
        )}" y="${(height - padding.bottom + 12).toFixed(
          2,
        )}" text-anchor="${anchor}" dominant-baseline="hanging" font-family="${safeFont}" font-size="${axisFontSize}" font-weight="${axisFontWeight}">${formatDateLabel(
          labels[idx],
        )}</text>`;
      }),
    ];

    const paths = seriesList
      .map((series) => {
        const values = (series.values || []).map((val) => Number(val) || 0);
        const { line, area } = buildChartPaths(values, width, height, dynamicPadding, maxTick);
        const areaClass = series.areaClass ? ` class="${series.areaClass}"` : "";
        const lineClass = series.lineClass ? ` class="${series.lineClass}"` : "";
        const areaColor = resolveClassColor(series.areaClass, colors.area);
        const lineColor = resolveClassColor(series.lineClass, colors.line);
        const areaPath = series.areaClass
          ? `<path${areaClass} d="${area}" fill="${areaColor}" />`
          : "";
        const linePath = `<path${lineClass} d="${line}" fill="none"${
          lineColor ? ` stroke="${lineColor}"` : ""
        } />`;
        return `${areaPath}${linePath}`;
      })
      .join("");

    const unitLabel =
      unit && unit !== "count"
        ? `<text class="admin-chart__unit" x="${dynamicPadding.left}" y="${(
            dynamicPadding.top - 8
          ).toFixed(2)}">${unit}</text>`
        : "";

    const axisLine = `<path class="admin-chart__axis-line" fill="none" d="M ${dynamicPadding.left} ${dynamicPadding.top} L ${dynamicPadding.left} ${
      height - dynamicPadding.bottom
    } L ${width - dynamicPadding.right} ${height - dynamicPadding.bottom}" />`;

    return `<svg class="admin-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" style="font-family:${safeFont};">
      <g class="admin-chart__grid">${gridLines.join("")}</g>
      ${axisLine}
      <g class="admin-chart__axis">${axisLabels.join("")}</g>
      ${unitLabel}
      ${paths}
    </svg>`;
  };

  const renderAdminChart = (holder, payload) => {
    if (!holder || !payload) return;
    holder.innerHTML = renderAdminChartSvg(payload);
  };

  const updateCustomSummary = (panel, payload) => {
    if (!panel || !payload) return;
    const seriesList = payload.series || [];
    panel.querySelectorAll("[data-range-metric]").forEach((node) => {
      const key = node.dataset.rangeMetric;
      const series = seriesList.find((item) => item.key === key);
      if (!series) return;
      const values = Array.isArray(series.sumValues) ? series.sumValues : series.values;
      const sum = (values || []).reduce((acc, value) => acc + (Number(value) || 0), 0);
      if (series.sumFormat === "bytes") {
        node.textContent = formatBytes(sum);
      } else {
        node.textContent = formatNumber(sum);
      }
    });
    const totalNode = panel.querySelector("[data-range-total]");
    if (totalNode) {
      const series = seriesList[0];
      if (series) {
        const values = Array.isArray(series.sumValues) ? series.sumValues : series.values;
        const sum = (values || []).reduce((acc, value) => acc + (Number(value) || 0), 0);
        totalNode.textContent = series.sumFormat === "bytes" ? formatBytes(sum) : formatNumber(sum);
      }
    }
  };

  const updateCustomRange = (card, days) => {
    if (!card) return;
    const sourceRaw = card.dataset.rangeSource || "";
    const source = parseChartPayload(sourceRaw);
    if (!source) return;
    const totalDays = source.labels.length;
    const safeDays = Math.max(1, Math.min(totalDays, days));
    const labels = source.labels.slice(-safeDays);
    const series = source.series.map((item) => {
      const values = (item.values || []).slice(-safeDays);
      const sumValues = Array.isArray(item.sumValues)
        ? item.sumValues.slice(-safeDays)
        : undefined;
      return { ...item, values, sumValues };
    });
    const payload = { ...source, labels, series };
    const panel = card.querySelector("[data-range-panel='custom']");
    if (!panel) return;
    const holder = panel.querySelector("[data-admin-chart]");
    if (holder) {
      renderAdminChart(holder, payload);
    }
    panel.querySelectorAll("[data-range-days]").forEach((node) => {
      node.textContent = String(safeDays);
    });
    updateCustomSummary(panel, payload);
    const label = card.querySelector("[data-range-label]");
    const active = card.querySelector(".range-btn.is-active");
    if (label && active && active.dataset.rangeValue === "custom") {
      label.textContent = `最近${safeDays}天`;
    }
  };

  const initRangeSwitch = () => {
    const switches = document.querySelectorAll("[data-range-switch]");
    if (!switches.length) return;
    switches.forEach((card) => {
      const buttons = Array.from(card.querySelectorAll("[data-range-value]"));
      const panels = Array.from(card.querySelectorAll("[data-range-panel]"));
      const label = card.querySelector("[data-range-label]");
      if (!buttons.length || !panels.length) return;
      const slider = card.querySelector("[data-range-slider]");
      const handleSlider = () => {
        if (!slider) return;
        const value = Number(slider.value || 1);
        updateCustomRange(card, value);
      };
      if (slider) {
        slider.addEventListener("input", handleSlider);
      }
      const setRange = (value) => {
        const target = String(value || "");
        buttons.forEach((btn) => {
          btn.classList.toggle(
            "is-active",
            btn.dataset.rangeValue === target,
          );
        });
        panels.forEach((panel) => {
          panel.hidden = panel.dataset.rangePanel !== target;
        });
        if (label) {
          if (target === "30") {
            label.textContent = "近30天";
          } else if (target === "custom") {
            const value = Number(slider?.value || 7);
            label.textContent = `最近${value}天`;
          } else {
            label.textContent = "近7天";
          }
        }
        if (target === "custom") {
          handleSlider();
        }
      };
      buttons.forEach((btn) => {
        btn.addEventListener("click", () => {
          setRange(btn.dataset.rangeValue || "");
        });
      });
      setRange(card.dataset.rangeDefault || "7");
      if (slider) {
        handleSlider();
      }
    });
  };

  const initAdminCharts = () => {
    document.querySelectorAll("[data-admin-chart]").forEach((holder) => {
      const payload = parseChartPayload(holder.dataset.adminChart || "");
      if (!payload) return;
      renderAdminChart(holder, payload);
    });
  };

  const initUserCreateModal = () => {
    const modal = document.querySelector("[data-user-create-modal]");
    if (!modal) return;
    const openButtons = document.querySelectorAll("[data-user-create-open]");
    if (!openButtons.length) return;
    const form = modal.querySelector("form");
    const close = () => {
      modal.hidden = true;
    };
    modal.addEventListener("click", (event) => {
      const target = event.target;
      if (
        target &&
        (target.matches("[data-modal-close]") ||
          target.classList.contains("modal-backdrop"))
      ) {
        close();
      }
    });
    openButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        if (form) form.reset();
        modal.hidden = false;
      });
    });
  };

  const initBatchConfirm = () => {
    document.querySelectorAll("form[data-batch-form]").forEach((form) => {
      form.addEventListener("submit", (event) => {
        const action = form.querySelector("select[name='action']")?.value || "";
        const type = form.getAttribute("data-batch-form") || "";
        if (type === "share" && action === "hard_delete") {
          const ok = window.confirm("确定要批量彻底删除所选分享吗？该操作不可恢复。");
          if (!ok) event.preventDefault();
        }
        if (type === "user" && action === "delete") {
          const ok = window.confirm("确定要批量删除所选用户及其所有分享吗？该操作不可恢复。");
          if (!ok) event.preventDefault();
        }
      });
    });
  };

  const initReportModal = () => {
    const openButtons = document.querySelectorAll("[data-report-open]");
    if (!openButtons.length) return;
    const open = (modal) => {
      if (modal) modal.hidden = false;
    };
    const close = (modal) => {
      if (modal) modal.hidden = true;
    };
    openButtons.forEach((btn) => {
      if (btn.dataset.reportOpenBound === "1") return;
      btn.dataset.reportOpenBound = "1";
      btn.addEventListener("click", () => {
        const targetId = btn.dataset.reportTarget || "";
        const modal = targetId
          ? document.getElementById(targetId)
          : document.querySelector("[data-report-modal]");
        open(modal);
      });
    });
    document.querySelectorAll("[data-report-modal]").forEach((modal) => {
      if (modal.dataset.reportModalBound === "1") return;
      modal.dataset.reportModalBound = "1";
      modal.addEventListener("click", (event) => {
        const target = event.target;
        if (
          target &&
          (target.closest("[data-modal-close]") ||
            target.classList.contains("modal-backdrop"))
        ) {
          close(modal);
        }
      });
    });
  };

  const initToggleSubmit = () => {
    document
      .querySelectorAll("input[data-toggle-input]")
      .forEach((input) => {
        input.addEventListener("change", () => {
          const form = input.closest("form");
          if (!form) return;
          const actionInput = form.querySelector("[data-toggle-action]");
          if (actionInput) {
            actionInput.value = input.checked ? "enable" : "disable";
          }
          form.submit();
        });
      });
  };

  const ensureToastStack = () => {
    let stack = document.querySelector(".toast-stack");
    if (!stack) {
      stack = document.createElement("div");
      stack.className = "toast-stack";
      document.body.appendChild(stack);
    }
    return stack;
  };

  const showToast = (message, variant = "") => {
    if (!message) return;
    const stack = ensureToastStack();
    const toast = document.createElement("div");
    toast.className = "toast";
    if (variant) toast.classList.add(variant);
    toast.textContent = message;
    stack.appendChild(toast);
    setTimeout(() => {
      toast.classList.add("is-hidden");
      toast.addEventListener("transitionend", () => toast.remove(), {
        once: true,
      });
    }, 4200);
  };

  const initCommentEditors = () => {
    const editors = Array.from(document.querySelectorAll("[data-comment-editor]"));
    if (!editors.length && commentEditorsGlobalBound) return;
    const insertAtCursor = (textarea, text) => {
      if (!textarea) return;
      const start = textarea.selectionStart || 0;
      const end = textarea.selectionEnd || 0;
      const value = textarea.value || "";
      textarea.value = value.slice(0, start) + text + value.slice(end);
      const pos = start + text.length;
      textarea.setSelectionRange(pos, pos);
      textarea.focus();
    };
    const closePanels = (except) => {
      document.querySelectorAll("[data-comment-editor] [data-emoji-panel]").forEach((panel) => {
        if (panel && panel !== except) panel.hidden = true;
      });
    };
    if (!commentEditorsGlobalBound) {
      document.addEventListener("click", (event) => {
        const target = event.target;
        if (target && target.closest("[data-comment-editor]")) return;
        closePanels();
      });
      commentEditorsGlobalBound = true;
    }
    editors.forEach((editor) => {
      if (editor.dataset.commentEditorBound === "1") return;
      editor.dataset.commentEditorBound = "1";
      const textarea = editor.querySelector("textarea");
      const emojiToggle = editor.querySelector("[data-emoji-toggle]");
      const emojiPanel = editor.querySelector("[data-emoji-panel]");
      const imageBtn = editor.querySelector("[data-image-insert]");
      const imageInput = editor.querySelector("[data-image-input]");
      const form = editor.closest("form");
      const uploadUrl =
        editor.closest("[data-comment-upload]")?.dataset.commentUpload || "";
      if (emojiToggle && emojiPanel) {
        emojiToggle.addEventListener("click", (event) => {
          event.preventDefault();
          const next = emojiPanel.hidden;
          closePanels(emojiPanel);
          emojiPanel.hidden = !next;
        });
      }
      if (emojiPanel) {
        emojiPanel.addEventListener("click", (event) => {
          const btn = event.target.closest("[data-emoji]");
          if (!btn) return;
          insertAtCursor(textarea, btn.dataset.emoji || "");
          emojiPanel.hidden = true;
        });
      }
      const uploadImage = async (file) => {
        if (!file) return;
        if (!uploadUrl) {
          showToast("无法上传图片", "error");
          return;
        }
        const csrf = form?.querySelector("input[name='csrf']")?.value || "";
        const body = new FormData();
        if (csrf) body.append("csrf", csrf);
        body.append("image", file);
        if (imageBtn) imageBtn.disabled = true;
        try {
          const resp = await fetch(uploadUrl, {method: "POST", body});
          const json = await resp.json().catch(() => null);
          if (!resp.ok || !json || json.code !== 0) {
            throw new Error(json?.msg || "图片上传失败");
          }
          const url = json?.data?.url || "";
          if (!url) {
            throw new Error("图片上传失败");
          }
          insertAtCursor(textarea, `![](${url})`);
        } catch (err) {
          showToast(err?.message || "图片上传失败", "error");
        } finally {
          if (imageBtn) imageBtn.disabled = false;
          if (imageInput) imageInput.value = "";
        }
      };
      if (imageBtn && imageInput) {
        imageBtn.addEventListener("click", () => {
          imageInput.click();
        });
        imageInput.addEventListener("change", () => {
          const file = imageInput.files?.[0];
          uploadImage(file);
        });
      }
    });
  };

  const initCommentModal = () => {
    const modal = document.querySelector("[data-comment-modal]");
    if (!modal) return;
    const form = modal.querySelector("[data-comment-form]");
    if (!form) return;
    const modalBound = modal.dataset.commentModalBound === "1";
    if (!modalBound) {
      modal.dataset.commentModalBound = "1";
    }
    const titleEl = modal.querySelector("[data-comment-modal-title]");
    const noteEl = modal.querySelector("[data-comment-modal-note]");
    const submitBtn = modal.querySelector("[data-comment-submit]");
    const emailInput = form.querySelector("input[name='email']");
    const captchaInput = form.querySelector("input[name='captcha']");
    const contentInput = form.querySelector("textarea[name='content']");
    const commentIdInput = form.querySelector("[data-comment-id]");
    const parentIdInput = form.querySelector("[data-comment-parent]");
    const verifyBlock = form.querySelector("[data-comment-verify]");
    const editorBlock = form.querySelector("[data-comment-editor-wrapper]");
    const actionBase = modal.dataset.commentActionBase || "";
    const docId = modal.dataset.commentDocId || "";
    const ownerDelete = modal.dataset.commentOwner === "1";
    const defaultEmail = modal.dataset.commentDefaultEmail || "";
    const refreshModalCaptcha = () => {
      const img = modal.querySelector("img[data-captcha]");
      if (img) refreshCaptcha(img);
    };
    const setRequired = (field, required) => {
      if (!field) return;
      if (required) {
        field.setAttribute("required", "");
      } else {
        field.removeAttribute("required");
      }
    };
    const open = (mode, dataset) => {
      if (!actionBase) return;
      modal.hidden = false;
      refreshModalCaptcha();
      const maskedEmail = dataset.commentEmail || "";
      if (mode === "reply") {
        if (titleEl) titleEl.textContent = "回复评论";
        if (noteEl)
          noteEl.textContent = maskedEmail ? `回复 ${maskedEmail}` : "回复评论";
        if (submitBtn) submitBtn.textContent = "发布回复";
        form.action = `${actionBase}/comment`;
        if (commentIdInput) commentIdInput.value = "";
        if (parentIdInput) parentIdInput.value = dataset.commentParentId || "";
        if (emailInput) emailInput.value = defaultEmail;
        if (captchaInput) captchaInput.value = "";
        if (contentInput) contentInput.value = "";
        if (verifyBlock) verifyBlock.hidden = false;
        if (editorBlock) editorBlock.hidden = false;
        setRequired(contentInput, true);
        setRequired(emailInput, true);
        setRequired(captchaInput, true);
      } else if (mode === "edit") {
        if (titleEl) titleEl.textContent = "编辑评论";
        if (noteEl)
          noteEl.textContent = maskedEmail
            ? `邮箱验证：${maskedEmail}`
            : "邮箱验证";
        if (submitBtn) submitBtn.textContent = "保存修改";
        form.action = `${actionBase}/comment/edit`;
        if (commentIdInput) commentIdInput.value = dataset.commentId || "";
        if (parentIdInput) parentIdInput.value = "";
        if (emailInput) emailInput.value = "";
        if (captchaInput) captchaInput.value = "";
        if (contentInput) contentInput.value = dataset.commentContent || "";
        if (verifyBlock) verifyBlock.hidden = false;
        if (editorBlock) editorBlock.hidden = false;
        setRequired(contentInput, true);
        setRequired(emailInput, true);
        setRequired(captchaInput, true);
      } else if (mode === "delete") {
        if (titleEl) titleEl.textContent = "删除评论";
        if (noteEl)
          noteEl.textContent = maskedEmail
            ? `确认删除该评论（${maskedEmail}）？`
            : "确认删除该评论？";
        if (submitBtn) submitBtn.textContent = "确认删除";
        form.action = `${actionBase}/comment/delete`;
        if (commentIdInput) commentIdInput.value = dataset.commentId || "";
        if (parentIdInput) parentIdInput.value = "";
        if (contentInput) contentInput.value = "";
        const skipVerify = ownerDelete || dataset.commentOwner === "1";
        if (verifyBlock) verifyBlock.hidden = skipVerify;
        if (editorBlock) editorBlock.hidden = true;
        setRequired(contentInput, false);
        setRequired(emailInput, !skipVerify);
        setRequired(captchaInput, !skipVerify);
      }
      if (noteEl) {
        noteEl.hidden = !noteEl.textContent;
      }
      if (docId) {
        const docInput = form.querySelector("[data-comment-doc]");
        if (docInput) docInput.value = docId;
      }
    };
    const close = () => {
      modal.hidden = true;
    };
    if (!modalBound) {
      modal.addEventListener("click", (event) => {
        const target = event.target;
        if (
          target &&
          (target.closest("[data-modal-close]") ||
            target.classList.contains("modal-backdrop"))
        ) {
          close();
        }
      });
    }
    document.querySelectorAll("[data-comment-action]").forEach((btn) => {
      if (btn.dataset.commentActionBound === "1") return;
      btn.dataset.commentActionBound = "1";
      btn.addEventListener("click", () => {
        const mode = btn.dataset.commentAction || "";
        if (!mode) return;
        const details = btn.closest("details");
        if (details) details.open = false;
        open(mode, btn.dataset);
      });
    });
    if (modal.dataset.commentReopen === "1") {
      const mode = modal.dataset.commentReopenMode || "reply";
      const dataset = {
        commentParentId: modal.dataset.commentReopenParent || "",
        commentEmail: modal.dataset.commentReopenNote || "",
      };
      open(mode, dataset);
      const reopenEmail = modal.dataset.commentReopenEmail || "";
      const reopenContent = modal.dataset.commentReopenContent || "";
      if (emailInput && reopenEmail) emailInput.value = reopenEmail;
      if (contentInput && reopenContent) contentInput.value = reopenContent;
    }
  };

  const initAdminCommentModal = () => {
    const modal = document.querySelector("[data-admin-comment-modal]");
    if (!modal) return;
    const form = modal.querySelector("[data-admin-comment-form]");
    if (!form) return;
    const idInput = form.querySelector("[data-admin-comment-id]");
    const contentInput = form.querySelector("[data-admin-comment-content]");
    const noteEl = modal.querySelector("[data-admin-comment-note]");
    const close = () => {
      modal.hidden = true;
    };
    const open = (dataset) => {
      modal.hidden = false;
      if (idInput) idInput.value = dataset.adminCommentId || "";
      if (contentInput) contentInput.value = dataset.adminCommentContent || "";
      const noteParts = [];
      const share = dataset.adminCommentShare || "";
      const email = dataset.adminCommentEmail || "";
      const created = dataset.adminCommentCreated || "";
      if (share) noteParts.push(`分享：${share}`);
      if (email) noteParts.push(`邮箱：${email}`);
      if (created) noteParts.push(`时间：${created}`);
      if (noteEl) {
        noteEl.textContent = noteParts.join(" / ");
        noteEl.hidden = !noteEl.textContent;
      }
      if (contentInput) contentInput.focus();
    };
    modal.addEventListener("click", (event) => {
      const target = event.target;
      if (
        target &&
        (target.closest("[data-modal-close]") ||
          target.classList.contains("modal-backdrop"))
      ) {
        close();
      }
    });
    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!target) return;
      const trigger = target.closest("[data-admin-comment-edit]");
      if (!trigger) return;
      event.preventDefault();
      open(trigger.dataset);
    });
  };

  const initFormConfirm = () => {
    document.querySelectorAll("form[data-confirm-message]").forEach((form) => {
      form.addEventListener("submit", (event) => {
        const message = form.getAttribute("data-confirm-message");
        if (message && !window.confirm(message)) {
          event.preventDefault();
        }
      });
    });
  };

  const initPaginationAutoSubmit = () => {
    document.querySelectorAll(".pagination-form select").forEach((select) => {
      select.addEventListener("change", () => {
        const form = select.closest("form");
        if (form) form.submit();
      });
    });
  };

  const initFlashToast = () => {
    const isApp = document.body.classList.contains("layout-app");
    const isShare = document.body.classList.contains("layout-share");
    if (!isApp && !isShare) return;
    const flashes = Array.from(document.querySelectorAll(".flash"));
    if (!flashes.length) return;
    let stack = document.querySelector(".toast-stack");
    if (!stack) {
      stack = document.createElement("div");
      stack.className = "toast-stack";
      document.body.appendChild(stack);
    }
    flashes.forEach((flash) => {
      const toast = flash.cloneNode(true);
      toast.classList.add("toast");
      toast.classList.remove("report-flash");
      toast.classList.remove("comment-flash");
      stack.appendChild(toast);
      flash.remove();
    });
    setTimeout(() => {
      stack.querySelectorAll(".toast").forEach((toast) => {
        toast.classList.add("is-hidden");
        toast.addEventListener("transitionend", () => toast.remove(), {
          once: true,
        });
      });
    }, 4200);
  };

const initImageViewer = () => {
    if (!document.body.classList.contains("layout-share")) return;
    if (imageViewerReady) return;
    imageViewerReady = true;

    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
    const getImageSrc = (img) =>
      img.getAttribute("data-src") || img.currentSrc || img.src || "";

    const isEmojiImage = (img) => {
      if (!img) return false;
      if (img.classList.contains("sps-emoji")) return true;
      const src = img.getAttribute("src") || "";
      return src.includes("/emojis/") || src.includes("emojis/");
    };

    const collectImages = () =>
      Array.from(
        document.querySelectorAll(".markdown-body img, .comment-content img"),
      ).filter((img) => !img.closest(".image-viewer") && !isEmojiImage(img));

    let viewer = document.querySelector(".image-viewer");
    if (!viewer) {
      viewer = document.createElement("div");
      viewer.className = "image-viewer";
      viewer.hidden = true;
      viewer.innerHTML = `
        <div class="image-viewer-backdrop" data-viewer-close></div>
        <div class="image-viewer-ui">
          <div class="image-viewer-count" data-viewer-count></div>
          <div class="image-viewer-actions">
            <button class="image-viewer-btn" type="button" data-viewer-zoom-out aria-label="\u7f29\u5c0f\u56fe\u7247" title="\u7f29\u5c0f\u56fe\u7247">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6 12h12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              </svg>
            </button>
            <span class="image-viewer-zoom" data-viewer-zoom>100%</span>
            <button class="image-viewer-btn" type="button" data-viewer-zoom-in aria-label="\u653e\u5927\u56fe\u7247" title="\u653e\u5927\u56fe\u7247">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 6v12M6 12h12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              </svg>
            </button>
            <button class="image-viewer-btn image-viewer-btn-text" type="button" data-viewer-one-to-one aria-label="\u539f\u59cb\u5c3a\u5bf8\uff081:1\uff09" title="\u539f\u59cb\u5c3a\u5bf8\uff081:1\uff09">1:1</button>
            <button class="image-viewer-btn" type="button" data-viewer-rotate-ccw aria-label="\u9006\u65f6\u9488\u65cb\u8f6c\u0039\u0030\u00b0" title="\u9006\u65f6\u9488\u65cb\u8f6c\u0039\u0030\u00b0">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M3 12a9 9 0 1 0 3-6.708" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                <polyline points="3 4 3 10 9 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
            <button class="image-viewer-btn" type="button" data-viewer-rotate-cw aria-label="\u987a\u65f6\u9488\u65cb\u8f6c\u0039\u0030\u00b0" title="\u987a\u65f6\u9488\u65cb\u8f6c\u0039\u0030\u00b0">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M21 12a9 9 0 1 1-3-6.708" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                <polyline points="21 4 21 10 15 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
            <a class="image-viewer-btn" data-viewer-download download aria-label="\u4e0b\u8f7d\u56fe\u7247" title="\u4e0b\u8f7d\u56fe\u7247">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <polyline points="7 10 12 15 17 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <line x1="12" y1="15" x2="12" y2="3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              </svg>
            </a>
            <button class="image-viewer-btn" type="button" data-viewer-close aria-label="\u5173\u95ed\u9884\u89c8" title="\u5173\u95ed\u9884\u89c8">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <line x1="6" y1="6" x2="18" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                <line x1="6" y1="18" x2="18" y2="6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              </svg>
            </button>
          </div>
          <div class="image-viewer-stage" data-viewer-stage>
            <img class="image-viewer-img" data-viewer-img alt="">
            <button class="image-viewer-nav prev" type="button" data-viewer-prev aria-label="\u4e0a\u4e00\u5f20" title="\u4e0a\u4e00\u5f20">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M15 18l-6-6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
            <button class="image-viewer-nav next" type="button" data-viewer-next aria-label="\u4e0b\u4e00\u5f20" title="\u4e0b\u4e00\u5f20">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M9 18l6-6-6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
          </div>
          <div class="image-viewer-thumbs" data-viewer-thumbs></div>
        </div>
      `;
      document.body.appendChild(viewer);
    }

    const stage = viewer.querySelector("[data-viewer-stage]");
    const image = viewer.querySelector("[data-viewer-img]");
    const zoomOut = viewer.querySelector("[data-viewer-zoom-out]");
    const zoomIn = viewer.querySelector("[data-viewer-zoom-in]");
    const zoomLabel = viewer.querySelector("[data-viewer-zoom]");
    const oneToOne = viewer.querySelector("[data-viewer-one-to-one]");
    const rotateCw = viewer.querySelector("[data-viewer-rotate-cw]");
    const rotateCcw = viewer.querySelector("[data-viewer-rotate-ccw]");
    const download = viewer.querySelector("[data-viewer-download]");
    const prevBtn = viewer.querySelector("[data-viewer-prev]");
    const nextBtn = viewer.querySelector("[data-viewer-next]");
    const thumbs = viewer.querySelector("[data-viewer-thumbs]");
    const count = viewer.querySelector("[data-viewer-count]");
    let navPositionRaf = 0;

    const scheduleNavPosition = () => {
      if (!image || !prevBtn || !nextBtn) return;
      if (navPositionRaf) return;
      navPositionRaf = requestAnimationFrame(() => {
        navPositionRaf = 0;
        prevBtn.style.top = "";
        nextBtn.style.top = "";
      });
    };

    if (image) {
      image.setAttribute("draggable", "false");
    }
    if (thumbs) {
      thumbs.addEventListener("click", (event) => event.stopPropagation());
      thumbs.addEventListener("pointerdown", (event) => event.stopPropagation());
    }

    const MIN_SCALE = 0.01;
    let items = [];
    let index = 0;
    let scale = 1;
    let translateX = 0;
    let translateY = 0;
    let rotation = 0;
    let oneToOneActive = false;
    let oneToOneScale = 1;
    let oneToOneRestore = null;
    let isDragging = false;
    let dragMoved = false;
    let suppressClickUntil = 0;
    let dragStartX = 0;
    let dragStartY = 0;
    let dragOriginX = 0;
    let dragOriginY = 0;

    const getViewportSize = () => {
      if (window.visualViewport) {
        return {
          width: window.visualViewport.width,
          height: window.visualViewport.height,
        };
      }
      return {width: window.innerWidth, height: window.innerHeight};
    };

    const applyOneToOneScale = () => {
      if (!image) return;
      const naturalWidth = image.naturalWidth || 0;
      const naturalHeight = image.naturalHeight || 0;
      if (!naturalWidth || !naturalHeight) return;
      const rect = image.getBoundingClientRect();
      const baseWidth =
        image.offsetWidth || rect.width / Math.max(scale, MIN_SCALE);
      const baseHeight =
        image.offsetHeight || rect.height / Math.max(scale, MIN_SCALE);
      const ratioW = baseWidth ? naturalWidth / baseWidth : 1;
      const ratioH = baseHeight ? naturalHeight / baseHeight : 1;
      oneToOneScale = Math.max(ratioW, ratioH);
      scale = oneToOneScale;
      translateX = 0;
      translateY = 0;
      applyTransform();
      requestAnimationFrame(() => {
        clampTranslation();
        applyTransform();
      });
    };

    const updateZoomLabel = () => {
      if (zoomLabel) {
        zoomLabel.textContent = `${Math.round(scale * 100)}%`;
      }
    };

    const clearOneToOne = () => {
      oneToOneActive = false;
      oneToOneScale = 1;
      oneToOneRestore = null;
      if (image) {
        image.style.width = "";
        image.style.height = "";
        image.style.maxWidth = "";
        image.style.maxHeight = "";
      }
    };

    const applyTransform = () => {
      if (!image) return;
      image.style.transform = `translate(${translateX}px, ${translateY}px) rotate(${rotation}deg) scale(${scale})`;
      updateZoomLabel();
      scheduleNavPosition();
    };

    const clampTranslation = () => {
      if (!stage || !image) return;
      const stageRect = stage.getBoundingClientRect();
      const imgRect = image.getBoundingClientRect();
      const baseWidth = imgRect.width / Math.max(scale, MIN_SCALE);
      const baseHeight = imgRect.height / Math.max(scale, MIN_SCALE);
      const scaledWidth = baseWidth * scale;
      const scaledHeight = baseHeight * scale;
      const maxX = Math.max(0, (scaledWidth - stageRect.width) / 2);
      const maxY = Math.max(0, (scaledHeight - stageRect.height) / 2);
      translateX = clamp(translateX, -maxX, maxX);
      translateY = clamp(translateY, -maxY, maxY);
    };

    const setScale = (nextScale) => {
      scale = Math.max(nextScale, MIN_SCALE);
      if (oneToOneActive && Math.abs(scale - oneToOneScale) > 0.001) {
        clearOneToOne();
      }
      applyTransform();
      requestAnimationFrame(() => {
        clampTranslation();
        applyTransform();
      });
    };

    const resetZoom = () => {
      scale = 1;
      translateX = 0;
      translateY = 0;
      rotation = 0;
      clearOneToOne();
      applyTransform();
    };

    const toggleOneToOne = () => {
      if (!image) return;
      if (!oneToOneActive) {
        oneToOneRestore = {
          scale,
          translateX,
          translateY,
          width: image.style.width,
          height: image.style.height,
          maxWidth: image.style.maxWidth,
          maxHeight: image.style.maxHeight,
        };
        oneToOneActive = true;
        applyOneToOneScale();
        return;
      }
      oneToOneActive = false;
      oneToOneScale = 1;
      if (oneToOneRestore) {
        translateX = oneToOneRestore.translateX || 0;
        translateY = oneToOneRestore.translateY || 0;
        scale = oneToOneRestore.scale || 1;
        image.style.width = oneToOneRestore.width || "";
        image.style.height = oneToOneRestore.height || "";
        image.style.maxWidth = oneToOneRestore.maxWidth || "";
        image.style.maxHeight = oneToOneRestore.maxHeight || "";
        applyTransform();
        requestAnimationFrame(() => {
          clampTranslation();
          applyTransform();
        });
        oneToOneRestore = null;
      } else {
        resetZoom();
      }
    };

    const rotateBy = (degrees) => {
      rotation += degrees;
      applyTransform();
      requestAnimationFrame(() => {
        clampTranslation();
        applyTransform();
      });
    };

    const updateThumbs = () => {
      if (!thumbs) return;
      thumbs.innerHTML = "";
      items.forEach((item, idx) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `image-viewer-thumb${idx === index ? " is-active" : ""}`;
        const img = document.createElement("img");
        img.src = getImageSrc(item);
        img.alt = item.alt || "";
        btn.appendChild(img);
        btn.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          setIndex(idx);
        });
        thumbs.appendChild(btn);
      });
      const active = thumbs.querySelector(".image-viewer-thumb.is-active");
      if (active && active.scrollIntoView) {
        active.scrollIntoView({block: "nearest", inline: "center"});
      }
    };

    const updateNav = () => {
      const disabled = items.length <= 1;
      if (prevBtn) prevBtn.disabled = disabled;
      if (nextBtn) nextBtn.disabled = disabled;
    };

    const updateView = () => {
      if (!image || !items.length) return;
      const item = items[index];
      const src = getImageSrc(item);
      image.src = src;
      image.alt = item.alt || "";
      if (download) download.href = src;
      if (count) count.textContent = `${index + 1} / ${items.length}`;
      updateNav();
      updateThumbs();
      image.onload = () => {
        resetZoom();
      };
      resetZoom();
    };

    const setIndex = (nextIndex) => {
      if (!items.length) return;
      index = (nextIndex + items.length) % items.length;
      updateView();
    };

    const openViewer = (startIndex) => {
      items = collectImages();
      if (!items.length) return;
      index = clamp(startIndex, 0, items.length - 1);
      viewer.hidden = false;
      document.body.classList.add("image-viewer-open");
      updateView();
    };

    const closeViewer = () => {
      viewer.hidden = true;
      document.body.classList.remove("image-viewer-open");
    };

    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!target) return;
      const img = target.closest("img");
      if (!img) return;
      if (img.closest(".image-viewer")) return;
      if (!img.matches(".markdown-body img, .comment-content img")) return;
      if (isEmojiImage(img)) return;
      const list = collectImages();
      const startIndex = list.indexOf(img);
      if (startIndex < 0) return;
      event.preventDefault();
      event.stopPropagation();
      openViewer(startIndex);
    });

    viewer.addEventListener("click", (event) => {
      if (Date.now() < suppressClickUntil) return;
      const target = event.target;
      if (!target) return;
      if (target.closest("[data-viewer-close]")) {
        closeViewer();
        return;
      }
      if (target.closest(".image-viewer-actions")) return;
      if (target.closest(".image-viewer-count")) return;
      if (target.closest(".image-viewer-nav")) return;
      if (target.closest(".image-viewer-img")) return;
      if (target.closest(".image-viewer-thumb")) return;
      if (target.closest(".image-viewer-thumbs")) return;
      closeViewer();
    });

    if (prevBtn) prevBtn.addEventListener("click", () => setIndex(index - 1));
    if (nextBtn) nextBtn.addEventListener("click", () => setIndex(index + 1));
    if (zoomIn) zoomIn.addEventListener("click", () => setScale(scale + 0.25));
    if (zoomOut) zoomOut.addEventListener("click", () => setScale(scale - 0.25));
    if (oneToOne) oneToOne.addEventListener("click", toggleOneToOne);
    if (rotateCw) rotateCw.addEventListener("click", () => rotateBy(90));
    if (rotateCcw) rotateCcw.addEventListener("click", () => rotateBy(-90));

    viewer.addEventListener(
      "wheel",
      (event) => {
        if (viewer.hidden) return;
        event.preventDefault();
        const zoomFactor = Math.exp(-event.deltaY * 0.002);
        setScale(scale * zoomFactor);
      },
      {passive: false},
    );

    document.addEventListener("keydown", (event) => {
      if (viewer.hidden) return;
      const target = event.target;
      if (target && ["INPUT", "TEXTAREA"].includes(target.tagName)) return;
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setScale(scale * 1.1);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        setScale(scale * 0.9);
      }
    });

    window.addEventListener("resize", () => {
      if (viewer.hidden) return;
      if (oneToOneActive) {
        applyOneToOneScale();
      } else {
        scheduleNavPosition();
      }
    });
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", () => {
        if (viewer.hidden) return;
        if (oneToOneActive) {
          applyOneToOneScale();
        } else {
          scheduleNavPosition();
        }
      });
    }

    const pointers = new Map();
    let isPinching = false;
    let pinchStartDistance = 0;
    let pinchStartScale = 1;
    let dragPointerId = null;

    const getPointerDistance = (a, b) =>
      Math.hypot(b.x - a.x, b.y - a.y);

    const canDrag = () => {
      if (!stage || !image) return false;
      const stageRect = stage.getBoundingClientRect();
      const imgRect = image.getBoundingClientRect();
      return (
        oneToOneActive ||
        scale > 1 ||
        imgRect.width > stageRect.width ||
        imgRect.height > stageRect.height
      );
    };

    const onPointerDown = (event) => {
      if (!stage || !image) return;
      const target = event.target;
      if (target && target.closest(".image-viewer-nav")) return;
      if (target && target.closest(".image-viewer-actions")) return;
      if (event.button !== undefined && event.button !== 0) return;
      pointers.set(event.pointerId, {x: event.clientX, y: event.clientY});
      if (stage.setPointerCapture) {
        stage.setPointerCapture(event.pointerId);
      }
      if (pointers.size === 2) {
        isPinching = true;
        isDragging = false;
        dragPointerId = null;
        const [p1, p2] = Array.from(pointers.values());
        pinchStartDistance = getPointerDistance(p1, p2);
        pinchStartScale = scale;
        event.preventDefault();
        return;
      }
      if (pointers.size === 1 && canDrag()) {
        isDragging = true;
        dragPointerId = event.pointerId;
        dragMoved = false;
        dragStartX = event.clientX;
        dragStartY = event.clientY;
        dragOriginX = translateX;
        dragOriginY = translateY;
        stage.classList.add("is-dragging");
        event.preventDefault();
      }
    };

    const onPointerMove = (event) => {
      if (!pointers.has(event.pointerId)) return;
      pointers.set(event.pointerId, {x: event.clientX, y: event.clientY});
      if (isPinching && pointers.size >= 2) {
        const [p1, p2] = Array.from(pointers.values());
        const distance = getPointerDistance(p1, p2);
        if (pinchStartDistance > 0) {
          setScale(pinchStartScale * (distance / pinchStartDistance));
        }
        event.preventDefault();
        return;
      }
      if (!isDragging || event.pointerId !== dragPointerId) return;
      const deltaX = event.clientX - dragStartX;
      const deltaY = event.clientY - dragStartY;
      if (!dragMoved && (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3)) {
        dragMoved = true;
      }
      translateX = dragOriginX + deltaX;
      translateY = dragOriginY + deltaY;
      clampTranslation();
      applyTransform();
    };

    const onPointerUp = (event) => {
      pointers.delete(event.pointerId);
      if (stage && stage.releasePointerCapture) {
        stage.releasePointerCapture(event.pointerId);
      }
      if (isPinching && pointers.size < 2) {
        isPinching = false;
        pinchStartDistance = 0;
        pinchStartScale = scale;
      }
      if (!isDragging || event.pointerId !== dragPointerId) return;
      isDragging = false;
      dragPointerId = null;
      if (stage) stage.classList.remove("is-dragging");
      if (dragMoved) {
        suppressClickUntil = Date.now() + 320;
      }
    };

    if (stage) {
      stage.addEventListener("pointerdown", onPointerDown);
    }
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);

    document.addEventListener("keydown", (event) => {
      if (viewer.hidden) return;
      if (event.key === "Escape") {
        closeViewer();
      } else if (event.key === "ArrowLeft") {
        setIndex(index - 1);
      } else if (event.key === "ArrowRight") {
        setIndex(index + 1);
      } else if (event.key === "+" || event.key === "=") {
        setScale(scale + 0.25);
      } else if (event.key === "-" || event.key === "_") {
        setScale(scale - 0.25);
      }
    });
  };

  const initScanProgress = () => {
    const form = document.querySelector("[data-scan-form]");
    const wrapper = document.querySelector("[data-scan-progress]");
    if (!form || !wrapper) return;
    const bar = wrapper.querySelector("[data-scan-bar]");
    const status = wrapper.querySelector("[data-scan-status]");
    const log = wrapper.querySelector("[data-scan-log]");
    const submitBtn = form.querySelector("button[type='submit']");
    const csrf = form.querySelector("input[name='csrf']")?.value || "";
    const logQueue = [];
    let logTimer = null;
    let doneMessage = "";
    let autoRefreshTimer = null;
    const post = async (url, payload) => {
      const body = new URLSearchParams(payload).toString();
      const resp = await fetch(url, {
        method: "POST",
        headers: {"Content-Type": "application/x-www-form-urlencoded"},
        body,
      });
      const json = await resp.json().catch(() => null);
      if (!resp.ok || !json || json.code !== 0) {
        throw new Error(json?.msg || "扫描请求失败");
      }
      return json.data || {};
    };

    const finalizeScan = () => {
      if (!doneMessage || logQueue.length || logTimer || autoRefreshTimer) return;
      if (status) status.textContent = doneMessage;
      doneMessage = "";
      autoRefreshTimer = setTimeout(() => {
        const url = new URL(window.location.href);
        url.searchParams.set("scan_keep", "1");
        url.hash = "scan";
        window.location.href = url.toString();
      }, 800);
    };

    const stripScanKeep = () => {
      const url = new URL(window.location.href);
      if (!url.searchParams.has("scan_keep")) return;
      url.searchParams.delete("scan_keep");
      const qs = url.searchParams.toString();
      const next = url.pathname + (qs ? `?${qs}` : "") + url.hash;
      window.history.replaceState(null, "", next);
    };

    const appendLogs = (logs) => {
      if (!log || !Array.isArray(logs) || !logs.length) return;
      logQueue.push(...logs);
      if (logTimer) return;
      const flush = () => {
        if (!logQueue.length || !log) {
          logTimer = null;
          finalizeScan();
          return;
        }
        const msg = logQueue.shift();
        const row = document.createElement("div");
        row.innerHTML = msg;
        log.appendChild(row);
        log.scrollTop = log.scrollHeight;
        logTimer = setTimeout(flush, 40);
      };
      flush();
    };

    stripScanKeep();

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      wrapper.hidden = false;
      if (log) log.innerHTML = "";
      logQueue.length = 0;
      if (logTimer) {
        clearTimeout(logTimer);
        logTimer = null;
      }
      if (status) status.textContent = "初始化扫描...";
      if (bar) bar.style.width = "0%";
      if (submitBtn) submitBtn.disabled = true;
      doneMessage = "";
      if (autoRefreshTimer) {
        clearTimeout(autoRefreshTimer);
        autoRefreshTimer = null;
      }

      try {
        const start = await post(form.action.replace(/\/scan$/, "/scan/start"), {
          csrf,
        });
        let offset = 0;
        const total = Number(start.total || 0);
        const limit = 50;
        while (true) {
          const step = await post(
            form.action.replace(/\/scan$/, "/scan/step"),
            {csrf, offset, limit},
          );
          offset = Number(step.nextOffset || offset);
          const progress = total > 0 ? Math.min(100, Math.round((offset / total) * 100)) : 100;
          if (bar) bar.style.width = `${progress}%`;
          if (status) {
            status.textContent = `扫描中：${offset}/${total || "-"} (${progress}%)`;
          }
          if (step.done) {
            doneMessage = `扫描完成，共命中 ${step.hitCount || 0} 条记录`;
          }
          appendLogs(step.logs || []);
          if (step.done) break;
        }
        finalizeScan();
      } catch (err) {
        if (status) status.textContent = err?.message || "扫描失败";
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  };

  const initMarkdown = () => {
    if (
      typeof window.markdownit !== "function" ||
      !window.markdownit.prototype ||
      typeof window.markdownit.prototype.render !== "function"
    ) {
      return;
    }

    const md = window.markdownit({
      html: true,
      linkify: true,
      typographer: true,
      breaks: true,
      highlight: (str, lang) => {
        const safeLang = (lang || "").toLowerCase();
        if (safeLang === "mermaid") {
          return "";
        }
        if (!window.hljs) return "";
        try {
          if (safeLang && window.hljs.getLanguage(safeLang)) {
            return window.hljs.highlight(str, {language: safeLang}).value;
          }
          return window.hljs.highlightAuto(str).value;
        } catch {
          return "";
        }
      },
    });

    const usePlugin = (plugin, options) => {
      if (typeof plugin !== "function") return;
      options ? md.use(plugin, options) : md.use(plugin);
    };

    const registerCalloutSupport = () => {
      const calloutPattern = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION|INFO)\]\s*/i;
      const calloutClassMap = {
        note: "note",
        tip: "tip",
        important: "important",
        warning: "warning",
        caution: "caution",
        info: "info",
      };
      const calloutMetaMap = {
        note: {label: "Note", icon: "🖊️"},
        tip: {label: "Tip", icon: "💡"},
        important: {label: "Important", icon: "❗"},
        warning: {label: "Warning", icon: "⚠️"},
        caution: {label: "Caution", icon: "🚨"},
        info: {label: "Info", icon: "ℹ️"},
      };

      const splitTitleHtml = (html) => {
        const trimmed = String(html || "").trim();
        if (!trimmed) return {icon: "", label: ""};
        const match = trimmed.match(/^<img\b[^>]*>/i);
        if (match) {
          const icon = match[0];
          const label = trimmed.slice(icon.length).trim();
          return {icon, label};
        }
        return {icon: "", label: trimmed};
      };

      const reparseInline = (inlineToken, text, env) => {
        inlineToken.content = text;
        if (md.inline && typeof md.inline.parse === "function") {
          const children = [];
          md.inline.parse(text, md, env || {}, children);
          inlineToken.children = children;
        }
      };

      const buildTitleHtml = (titleRaw, meta) => {
        if (titleRaw) {
          const titleHtml = typeof md.renderInline === "function" ? md.renderInline(titleRaw) : titleRaw;
          const parts = splitTitleHtml(titleHtml);
          const iconHtml = parts.icon ? `<span class="md-alert__icon">${parts.icon}</span>` : "";
          const labelHtml = parts.label ? `<span class="md-alert__label">${parts.label}</span>` : "";
          return `<div class="md-alert__title">${iconHtml}${labelHtml}</div>\n`;
        }
        return (
          `<div class="md-alert__title"><span class="md-alert__icon">${meta.icon}</span>` +
          `<span class="md-alert__label">${meta.label}</span></div>\n`
        );
      };

      md.block.ruler.before("blockquote", "siyuan_callout_block", (state, startLine, endLine, silent) => {
        let pos = state.bMarks[startLine] + state.tShift[startLine];
        let max = state.eMarks[startLine];
        if (state.src[pos] !== ">") return false;
        let line = state.src.slice(pos + 1, max);
        if (line.startsWith(" ")) line = line.slice(1);
        if (!calloutPattern.test(line)) return false;
        if (silent) return true;

        let nextLine = startLine;
        let content = "";
        while (nextLine < endLine) {
          pos = state.bMarks[nextLine] + state.tShift[nextLine];
          max = state.eMarks[nextLine];
          if (state.src[pos] !== ">") break;
          let row = state.src.slice(pos + 1, max);
          if (row.startsWith(" ")) row = row.slice(1);
          if (nextLine !== startLine && calloutPattern.test(row)) {
            break;
          }
          content += row + "\n";
          nextLine += 1;
        }

        const lines = content.split(/\r?\n/);
        const firstLine = lines.shift() ?? "";
        const match = firstLine.match(calloutPattern);
        if (!match) return false;
        const typeKey = match[1].toLowerCase();
        const classKey = calloutClassMap[typeKey] || "note";
        const meta = calloutMetaMap[classKey] || calloutMetaMap.note;
        const titleRaw = firstLine.replace(calloutPattern, "").trim();
        const body = lines.join("\n");

        const open = state.push("html_block", "", 0);
        open.block = true;
        open.content = `<div class="md-alert md-alert--${classKey}">\n`;
        const titleToken = state.push("html_block", "", 0);
        titleToken.block = true;
        titleToken.content = buildTitleHtml(titleRaw, meta);
        if (body.trim()) {
          state.md.block.parse(body, state.md, state.env, state.tokens);
        }
        const close = state.push("html_block", "", 0);
        close.block = true;
        close.content = "</div>\n";
        state.line = nextLine;
        return true;
      });
    };

    const useKatex = () => {
      if (typeof window.markdownitKatex === "function") {
        md.use(window.markdownitKatex, {throwOnError: false, errorColor: "#cc0000"});
        return;
      }
      if (!window.katex || typeof window.katex.renderToString !== "function") return;

      const renderKatex = (source, displayMode) => {
        try {
          return window.katex.renderToString(String(source || ""), {
            displayMode,
            throwOnError: false,
            errorColor: "#cc0000",
          });
        } catch {
          return md.utils.escapeHtml(String(source || ""));
        }
      };

      md.inline.ruler.after("escape", "katex_inline", (state, silent) => {
        if (state.src[state.pos] !== "$") return false;
        if (state.src[state.pos + 1] === "$") return false;
        let start = state.pos + 1;
        let match = start;
        while ((match = state.src.indexOf("$", match)) !== -1) {
          if (state.src[match - 1] === "\\") {
            match += 1;
            continue;
          }
          const content = state.src.slice(start, match);
          if (!content.trim()) {
            match += 1;
            continue;
          }
          if (!silent) {
            const token = state.push("katex_inline", "math", 0);
            token.content = content;
            token.markup = "$";
          }
          state.pos = match + 1;
          return true;
        }
        return false;
      });

      md.block.ruler.after("blockquote", "katex_block", (state, startLine, endLine, silent) => {
        let pos = state.bMarks[startLine] + state.tShift[startLine];
        let max = state.eMarks[startLine];
        if (state.src.slice(pos, pos + 2) !== "$$") return false;
        if (silent) return true;
        pos += 2;
        let firstLine = state.src.slice(pos, max);
        let nextLine = startLine;
        let content = "";
        if (firstLine.trim().endsWith("$$")) {
          const line = firstLine.trim();
          content = line.slice(0, -2).trim();
        } else {
          content = firstLine;
          for (nextLine = startLine + 1; nextLine < endLine; nextLine += 1) {
            pos = state.bMarks[nextLine] + state.tShift[nextLine];
            max = state.eMarks[nextLine];
            const line = state.src.slice(pos, max);
            if (line.trim() === "$$") {
              break;
            }
            content += `\n${line}`;
          }
          if (nextLine >= endLine) return false;
        }
        state.line = nextLine + 1;
        const token = state.push("katex_block", "math", 0);
        token.block = true;
        token.content = content.trim();
        token.map = [startLine, state.line];
        token.markup = "$$";
        return true;
      }, {alt: ["paragraph", "reference", "blockquote", "list"]});

      md.renderer.rules.katex_inline = (tokens, idx) =>
        renderKatex(tokens[idx].content, false);
      md.renderer.rules.katex_block = (tokens, idx) =>
        `<div class="katex-block">${renderKatex(tokens[idx].content, true)}</div>`;
    };

    useKatex();
    usePlugin(window.markdownitTaskLists, {enabled: true});
    usePlugin(window.markdownitEmoji);
    usePlugin(window.markdownitFootnote);
    usePlugin(window.markdownitDeflist);
    usePlugin(window.markdownitMark);
    usePlugin(window.markdownitSub);
    usePlugin(window.markdownitSup);
    usePlugin(window.markdownitAbbr);
    usePlugin(window.markdownitIns);
    usePlugin(window.markdownItAnchor || window.markdownitAnchor, {permalink: false});
    registerCalloutSupport();

    if (typeof window.markdownitContainer === "function") {
      const containers = ["info", "success", "warning", "danger", "tip", "note"];
      containers.forEach((type) => {
        md.use(window.markdownitContainer, type, {
          render: (tokens, idx) => {
            if (tokens[idx].nesting === 1) {
              return `<div class="md-alert md-alert--${type}">`;
            }
            return "</div>";
          },
        });
      });
    }

    let mermaidReady = false;
    let chartResizeBound = false;
    const chartInstances = [];
    let diagramIndex = 0;
    let vizInstance = null;
    const PLANTUML_SERVER = "https://plantuml.com/plantuml";
    let mermaidFontPromise = null;

    const nextDiagramId = (prefix) => {
      diagramIndex += 1;
      return `md-${prefix}-${diagramIndex}`;
    };

    const getLanguage = (code) => {
      if (!code) return "";
      const classes = Array.from(code.classList || []);
      for (const cls of classes) {
        if (cls.startsWith("language-")) {
          const lang = cls.slice(9).toLowerCase();
          if (["", "undefined", "text", "plain", "plaintext", "nohighlight"].includes(lang)) {
            continue;
          }
          return lang;
        }
        if (cls.startsWith("lang-")) {
          const lang = cls.slice(5).toLowerCase();
          if (["", "undefined", "text", "plain", "plaintext", "nohighlight"].includes(lang)) {
            continue;
          }
          return lang;
        }
      }
      if (classes.includes("mermaid")) return "mermaid";
      return "";
    };

    const getMermaidFontFamily = () => {
      if (typeof window.getComputedStyle !== "function") return "";
      const target = document.body || document.documentElement;
      if (!target) return "";
      const fontFamily = window.getComputedStyle(target).fontFamily;
      return fontFamily ? fontFamily.trim() : "";
    };

    const waitForMermaidFonts = (callback) => {
      if (!document.fonts || !document.fonts.ready || typeof document.fonts.ready.then !== "function") {
        callback();
        return;
      }
      if (!mermaidFontPromise) {
        mermaidFontPromise = document.fonts.ready.catch(() => null);
      }
      mermaidFontPromise.then(callback);
    };

    const getFirstMermaidLine = (text) => {
      const lines = String(text || "").split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith("%%")) continue;
        return trimmed;
      }
      return "";
    };

    const looksLikeMermaid = (text) => {
      const first = getFirstMermaidLine(text);
      return /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|gitGraph|mindmap|timeline|pie|quadrantChart|requirementDiagram|c4Context|c4Container|c4Component|c4Dynamic|zenuml|xychart)\b/i.test(
        first,
      );
    };

    const isMermaidFlowchart = (text) => {
      const first = getFirstMermaidLine(text);
      return /^(graph|flowchart)\b/i.test(first);
    };

    const isMermaidMindmap = (text) => {
      const first = getFirstMermaidLine(text);
      return /^mindmap\b/i.test(first);
    };

    const replaceCodeBlock = (code, replacement) => {
      const wrapper = code.closest(".code-block");
      if (wrapper) {
        wrapper.replaceWith(replacement);
        return;
      }
      const pre = code.closest("pre");
      if (pre) {
        pre.replaceWith(replacement);
      } else {
        code.replaceWith(replacement);
      }
    };

    const buildMindmapSource = (source) => {
      const lines = String(source || "").split(/\r?\n/);
      const items = [];
      lines.forEach((line) => {
        const match = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
        if (!match) return;
        const indent = match[1].replace(/\t/g, "  ").length;
        const level = Math.max(0, Math.floor(indent / 2));
        let text = match[2].trim();
        text = text.replace(/^\[(?: |x|X)\]\s*/, "");
        if (text) items.push({level, text});
      });
      if (!items.length) return "";
      const output = ["mindmap", "  root"];
      items.forEach((item) => {
        const pad = "  ".repeat(item.level + 2);
        output.push(`${pad}${item.text}`);
      });
      return output.join("\n");
    };

    const renderMindmap = (container) => {
      container.querySelectorAll("pre code").forEach((code) => {
        const lang = getLanguage(code);
        if (lang !== "mindmap" && lang !== "mermaid") return;
        const source = code.textContent || "";
        if (lang === "mindmap" && isMermaidMindmap(source)) return;
        if (lang === "mermaid" && looksLikeMermaid(source)) return;
        const mermaidSource = buildMindmapSource(source);
        if (!mermaidSource) return;
        const block = document.createElement("div");
        block.className = "mermaid";
        block.textContent = mermaidSource;
        replaceCodeBlock(code, block);
      });
    };

    const bindChartResize = () => {
      if (chartResizeBound) return;
      chartResizeBound = true;
      window.addEventListener("resize", () => {
        chartInstances.forEach((chart) => {
          try {
            chart.resize();
          } catch {
            // ignore resize failures
          }
        });
      });
    };

    const renderEcharts = (container) => {
      if (!window.echarts || typeof window.echarts.init !== "function") return;
      container.querySelectorAll("pre code").forEach((code) => {
        const lang = getLanguage(code);
        if (lang !== "echarts") return;
        const source = code.textContent || "";
        let option = null;
        try {
          option = JSON.parse(source);
        } catch {
          return;
        }
        const wrapper = document.createElement("div");
        wrapper.className = "md-diagram md-diagram--echarts";
        const chartEl = document.createElement("div");
        chartEl.className = "md-echarts";
        wrapper.appendChild(chartEl);
        replaceCodeBlock(code, wrapper);
        try {
          const chart = window.echarts.init(chartEl);
          chart.setOption(option, true);
          chartInstances.push(chart);
          bindChartResize();
        } catch {
          wrapper.textContent = "ECharts render failed.";
        }
      });
    };

    const renderAbc = (container) => {
      if (!window.ABCJS || typeof window.ABCJS.renderAbc !== "function") return;
      container.querySelectorAll("pre code").forEach((code) => {
        const lang = getLanguage(code);
        if (lang !== "abc") return;
        let source = code.textContent || "";
        let options = {};
        const lines = source.split(/\r?\n/);
        if (lines.length && lines[0].trim().startsWith("%%params")) {
          const raw = lines[0].trim().replace(/^%%params\s+/, "");
          try {
            options = JSON.parse(raw);
            source = lines.slice(1).join("\n");
          } catch {
            options = {};
          }
        }
        const wrapper = document.createElement("div");
        wrapper.className = "md-diagram md-diagram--abc";
        const target = document.createElement("div");
        const targetId = nextDiagramId("abc");
        target.id = targetId;
        wrapper.appendChild(target);
        replaceCodeBlock(code, wrapper);
        try {
          window.ABCJS.renderAbc(targetId, source, options);
        } catch {
          wrapper.textContent = "ABC render failed.";
        }
      });
    };

    const createVizInstance = () => {
      if (!window.Viz) return null;
      if (window.Module && window.render) {
        return new window.Viz({Module: window.Module, render: window.render});
      }
      return new window.Viz();
    };

    const renderGraphviz = (container) => {
      if (!window.Viz) return;
      container.querySelectorAll("pre code").forEach((code) => {
        const lang = getLanguage(code);
        if (lang !== "graphviz" && lang !== "dot") return;
        const source = code.textContent || "";
        const wrapper = document.createElement("div");
        wrapper.className = "md-diagram md-diagram--graphviz";
        const target = document.createElement("div");
        target.className = "md-graphviz";
        wrapper.appendChild(target);
        replaceCodeBlock(code, wrapper);
        if (!vizInstance) vizInstance = createVizInstance();
        if (!vizInstance || typeof vizInstance.renderSVGElement !== "function") {
          wrapper.textContent = "Graphviz render unavailable.";
          return;
        }
        vizInstance
          .renderSVGElement(source)
          .then((svg) => {
            target.innerHTML = "";
            target.appendChild(svg);
          })
          .catch(() => {
            vizInstance = createVizInstance();
            wrapper.textContent = "Graphviz render failed.";
          });
      });
    };

    const renderFlowchart = (container) => {
      if (!window.flowchart || typeof window.flowchart.parse !== "function") return;
      if (!window.Raphael) return;
      container.querySelectorAll("pre code").forEach((code) => {
        const lang = getLanguage(code);
        if (lang !== "flowchart") return;
        const source = code.textContent || "";
        if (isMermaidFlowchart(source)) return;
        let chart = null;
        try {
          chart = window.flowchart.parse(source);
        } catch {
          return;
        }
        const wrapper = document.createElement("div");
        wrapper.className = "md-diagram md-diagram--flowchart";
        const target = document.createElement("div");
        const targetId = nextDiagramId("flowchart");
        target.id = targetId;
        wrapper.appendChild(target);
        replaceCodeBlock(code, wrapper);
        try {
          chart.drawSVG(targetId, {
            "line-width": 2,
            "font-size": 14,
            "font-family": "inherit",
            "text-margin": 8,
            "yes-text": "yes",
            "no-text": "no",
            "arrow-end": "block",
          });
        } catch {
          wrapper.textContent = "Flowchart render failed.";
        }
      });
    };

    const encodePlantUmlData = (deflated) => {
      if (!deflated || !deflated.length) return "";
      const encode6bit = (b) => {
        if (b < 10) return String.fromCharCode(48 + b);
        b -= 10;
        if (b < 26) return String.fromCharCode(65 + b);
        b -= 26;
        if (b < 26) return String.fromCharCode(97 + b);
        b -= 26;
        if (b === 0) return "-";
        if (b === 1) return "_";
        return "?";
      };
      const append3bytes = (b1, b2, b3) => {
        const c1 = b1 >> 2;
        const c2 = ((b1 & 0x3) << 4) | (b2 >> 4);
        const c3 = ((b2 & 0xf) << 2) | (b3 >> 6);
        const c4 = b3 & 0x3f;
        return (
          encode6bit(c1 & 0x3f) +
          encode6bit(c2 & 0x3f) +
          encode6bit(c3 & 0x3f) +
          encode6bit(c4 & 0x3f)
        );
      };
      let result = "";
      for (let i = 0; i < deflated.length; i += 3) {
        if (i + 2 === deflated.length) {
          result += append3bytes(deflated[i], deflated[i + 1], 0);
        } else if (i + 1 === deflated.length) {
          result += append3bytes(deflated[i], 0, 0);
        } else {
          result += append3bytes(deflated[i], deflated[i + 1], deflated[i + 2]);
        }
      }
      return result;
    };

    const toUtf8Bytes = (input) => {
      if (typeof TextEncoder !== "undefined") {
        return new TextEncoder().encode(input);
      }
      const encoded = unescape(encodeURIComponent(input));
      const bytes = new Uint8Array(encoded.length);
      for (let i = 0; i < encoded.length; i += 1) {
        bytes[i] = encoded.charCodeAt(i);
      }
      return bytes;
    };

    const deflateWithPako = (bytes) => {
      if (!window.pako || typeof window.pako.deflate !== "function") return null;
      try {
        return window.pako.deflate(bytes, {level: 9});
      } catch {
        return null;
      }
    };

    const encodePlantUmlHex = (source) => {
      const input = String(source || "");
      if (!input.trim()) return "";
      const bytes = toUtf8Bytes(input);
      let hex = "";
      bytes.forEach((b) => {
        hex += b.toString(16).padStart(2, "0");
      });
      return `~h${hex}`;
    };

    const deflateWithStream = async (bytes) => {
      if (typeof CompressionStream !== "function") return null;
      try {
        const stream = new CompressionStream("deflate");
        const writer = stream.writable.getWriter();
        await writer.write(bytes);
        await writer.close();
        const buffer = await new Response(stream.readable).arrayBuffer();
        return new Uint8Array(buffer);
      } catch {
        return null;
      }
    };

    const encodePlantUmlSync = (source) => {
      const input = String(source || "");
      if (!input.trim()) return "";
      const bytes = toUtf8Bytes(input);
      const deflated = deflateWithPako(bytes);
      if (!deflated) return "";
      const encoded = encodePlantUmlData(deflated);
      return encoded ? `~1${encoded}` : "";
    };

    const encodePlantUmlAsync = async (source) => {
      const input = String(source || "");
      if (!input.trim()) return "";
      const bytes = toUtf8Bytes(input);
      let deflated = deflateWithPako(bytes);
      if (!deflated) {
        deflated = await deflateWithStream(bytes);
      }
      if (!deflated) return "";
      const encoded = encodePlantUmlData(deflated);
      return encoded ? `~1${encoded}` : "";
    };

    const renderPlantUml = (container) => {
      container.querySelectorAll("pre code").forEach((code) => {
        const lang = getLanguage(code);
        if (!["plantuml", "puml", "uml"].includes(lang)) return;
        const source = code.textContent || "";
        const hexFallback = encodePlantUmlHex(source);
        if (!hexFallback) return;
        if (!code.isConnected) return;
        const wrapper = document.createElement("div");
        wrapper.className = "md-diagram md-diagram--plantuml";
        const img = document.createElement("img");
        img.loading = "lazy";
        img.alt = "PlantUML diagram";
        img.src = `${PLANTUML_SERVER}/svg/${hexFallback}`;
        wrapper.appendChild(img);
        replaceCodeBlock(code, wrapper);

        const encodedSync = encodePlantUmlSync(source);
        if (encodedSync) {
          img.src = `${PLANTUML_SERVER}/svg/${encodedSync}`;
          return;
        }
        encodePlantUmlAsync(source).then((encodedAsync) => {
          if (encodedAsync) {
            img.src = `${PLANTUML_SERVER}/svg/${encodedAsync}`;
          }
        });
      });
    };

    const renderMermaid = (container) => {
      const isMermaidCodeBlock = (lang, source) => {
        if (lang === "mermaid") return true;
        if (lang === "mindmap") return isMermaidMindmap(source);
        if (lang === "flowchart") return isMermaidFlowchart(source);
        if (lang === "" && looksLikeMermaid(source)) return true;
        return false;
      };

      const fallbackMermaidImage = (block) => {
        const source = block.dataset.mermaidSource || block.textContent || "";
        if (!source.trim()) return;
        let encoded = "";
        try {
          encoded = btoa(unescape(encodeURIComponent(source)));
        } catch {
          return;
        }
        const wrapper = document.createElement("div");
        wrapper.className = "md-diagram md-diagram--mermaid";
        const img = document.createElement("img");
        img.loading = "lazy";
        img.alt = "Mermaid diagram";
        img.src = `https://mermaid.ink/svg/${encoded}`;
        wrapper.appendChild(img);
        block.replaceWith(wrapper);
      };

      const isMermaidErrorSvg = (svg) => {
        const text = String(svg || "");
        return /syntax error|parse error|error in text/i.test(text);
      };

      const renderMermaidBlock = (block) => {
        const source = block.dataset.mermaidSource || block.textContent || "";
        if (!source.trim()) return;
        const targetId = nextDiagramId("mermaid");
        const applySvg = (svg, bindFunctions) => {
          if (isMermaidErrorSvg(svg)) {
            fallbackMermaidImage(block);
            return;
          }
          block.innerHTML = svg;
          if (typeof bindFunctions === "function") {
            try {
              bindFunctions(block);
            } catch {
              // ignore bind errors
            }
          }
        };
        try {
          const result = window.mermaid.render(targetId, source);
          if (result && typeof result.then === "function") {
            result
              .then((res) => {
                if (!res || !res.svg) {
                  fallbackMermaidImage(block);
                  return;
                }
                applySvg(res.svg, res.bindFunctions);
              })
              .catch(() => fallbackMermaidImage(block));
            return;
          }
          if (typeof result === "string") {
            applySvg(result);
            return;
          }
          if (result && result.svg) {
            applySvg(result.svg, result.bindFunctions);
            return;
          }
          fallbackMermaidImage(block);
        } catch {
          fallbackMermaidImage(block);
        }
      };

      if (!window.mermaid) {
        const blocks = [];
        container.querySelectorAll("pre code").forEach((code) => {
          const lang = getLanguage(code);
          const source = code.textContent || "";
          if (!isMermaidCodeBlock(lang, source)) return;
          const pre = code.closest("pre");
          const block = document.createElement("div");
          block.className = "mermaid";
          block.dataset.mermaidSource = source;
          block.textContent = source;
          if (pre) {
            pre.replaceWith(block);
          } else {
            code.replaceWith(block);
          }
          blocks.push(block);
        });
        container.querySelectorAll("div.mermaid").forEach((block) => blocks.push(block));
        const uniqueBlocks = Array.from(new Set(blocks));
        uniqueBlocks.forEach((block) => fallbackMermaidImage(block));
        return;
      }
      if (!mermaidReady) {
        try {
          const mermaidFontFamily = getMermaidFontFamily();
          const ganttWidth = Math.max(
            1200,
            document.documentElement ? document.documentElement.clientWidth : 1200,
          );
          window.mermaid.initialize({
            startOnLoad: false,
            theme: "default",
            securityLevel: "loose",
            htmlLabels: false,
            flowchart: {
              htmlLabels: false,
              useMaxWidth: true,
            },
            sequence: {
              useMaxWidth: true,
            },
            mindmap: {
              useMaxWidth: true,
            },
            gantt: {
              useMaxWidth: false,
              useWidth: ganttWidth,
              barHeight: 24,
              barGap: 8,
              topPadding: 50,
              leftPadding: 80,
              rightPadding: 40,
              fontSize: 16,
              sectionFontSize: 16,
            },
            themeVariables: {
              fontFamily: mermaidFontFamily || "Arial, sans-serif",
              fontSize: "16px",
            },
          });
        } catch {
          // ignore init errors
        }
        mermaidReady = true;
      }
      const blocks = [];
      container.querySelectorAll("pre code").forEach((code) => {
        const lang = getLanguage(code);
        const source = code.textContent || "";
        if (!isMermaidCodeBlock(lang, source)) return;
        const pre = code.closest("pre");
        const block = document.createElement("div");
        block.className = "mermaid";
        block.dataset.mermaidSource = source;
        block.textContent = source;
        if (pre) {
          pre.replaceWith(block);
        } else {
          code.replaceWith(block);
        }
        blocks.push(block);
      });
      container.querySelectorAll("div.mermaid").forEach((block) => blocks.push(block));
      const uniqueBlocks = Array.from(new Set(blocks)).filter(
        (block) => !block.hasAttribute("data-processed"),
      );
      if (!uniqueBlocks.length) return;
      uniqueBlocks.forEach((block) => {
        block.setAttribute("data-processed", "true");
        renderMermaidBlock(block);
      });
    };

    const renderMermaidWithFonts = (container) => {
      waitForMermaidFonts(() => renderMermaid(container));
    };

    const writeClipboardText = async (text) => {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
      const helper = document.createElement("textarea");
      helper.value = text;
      helper.setAttribute("readonly", "true");
      helper.style.position = "fixed";
      helper.style.top = "-9999px";
      helper.style.left = "-9999px";
      document.body.appendChild(helper);
      helper.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      helper.remove();
      return ok;
    };

    const buildLineNumbers = (raw) => {
      const trimmed = raw.replace(/\r?\n$/, "");
      const lines = trimmed ? trimmed.split("\n") : [""];
      return lines.map((_, idx) => String(idx + 1)).join("\n");
    };

    const decorateCodeBlocks = (container) => {
      container.querySelectorAll("pre > code").forEach((code) => {
        if (code.closest(".md-diagram")) return;
        const lang = getLanguage(code);
        if (["mermaid", "mindmap", "echarts", "abc", "graphviz", "dot", "flowchart"].includes(lang)) {
          return;
        }
        const pre = code.parentElement;
        if (!pre || pre.closest(".code-block")) return;
        const raw = code.textContent || "";
        const wrapper = document.createElement("div");
        wrapper.className = "code-block";
        const header = document.createElement("div");
        header.className = "code-header";
        const langLabel = document.createElement("span");
        langLabel.className = "code-lang";
        langLabel.textContent = lang || "text";
        const copyBtn = document.createElement("button");
        copyBtn.type = "button";
        copyBtn.className = "code-copy";
        copyBtn.setAttribute("aria-label", "复制");
        copyBtn.setAttribute("data-tooltip", "复制");
        copyBtn.innerHTML =
          "<svg class=\"code-copy-icon\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" focusable=\"false\">" +
          "<rect x=\"9\" y=\"9\" width=\"10\" height=\"12\" rx=\"2\" ry=\"2\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"></rect>" +
          "<path d=\"M5 15V5a2 2 0 0 1 2-2h10\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"></path>" +
          "</svg>";
        copyBtn.addEventListener("click", async () => {
          const success = await writeClipboardText(raw);
          if (success) {
            copyBtn.setAttribute("data-tooltip", "已复制");
            copyBtn.classList.add("is-copied");
            setTimeout(() => {
              copyBtn.setAttribute("data-tooltip", "复制");
              copyBtn.classList.remove("is-copied");
            }, 1500);
          }
        });
        if (lang || langLabel.textContent) {
          header.appendChild(langLabel);
        } else {
          header.classList.add("is-no-lang");
        }
        header.appendChild(copyBtn);
        const body = document.createElement("div");
        body.className = "code-body";
        const linesPre = document.createElement("pre");
        linesPre.className = "code-lines";
        const linesCode = document.createElement("code");
        linesCode.textContent = buildLineNumbers(raw);
        linesPre.appendChild(linesCode);
        wrapper.appendChild(header);
        wrapper.appendChild(body);
        body.appendChild(linesPre);
        pre.replaceWith(wrapper);
        body.appendChild(pre);
      });
    };

    const wrapScrollableMedia = (container) => {
      const selector = "img, svg, canvas, iframe, embed, object, video";
      container.querySelectorAll(selector).forEach((el) => {
        if (el.closest(".md-diagram, .mermaid, .code-block, .media-scroll")) {
          return;
        }
        const tag = el.tagName.toLowerCase();
        if (tag === "img") return;
        if (tag === "iframe") return;
        if (tag === "video") return;
        if (tag === "svg" && el.ownerSVGElement) return;
        const wrapper = document.createElement("div");
        wrapper.className = "media-scroll";
        const parent = el.parentNode;
        if (!parent) return;
        parent.insertBefore(wrapper, el);
        wrapper.appendChild(el);
      });
    };

    const isMobileViewport = () =>
      typeof window.matchMedia === "function" &&
      window.matchMedia("(max-width: 900px)").matches;

    const ensureIframeWrapper = (iframe) => {
      if (!iframe) return null;
      const mediaWrapper = iframe.closest(".media-scroll");
      if (mediaWrapper && mediaWrapper.contains(iframe)) {
        mediaWrapper.replaceWith(iframe);
      }
      const existingShell = iframe.closest(".iframe-shell");
      if (existingShell) return existingShell;
      const existingFit = iframe.closest(".iframe-fit");
      if (existingFit) {
        existingFit.classList.add("iframe-shell");
        return existingFit;
      }
      const innerParent = iframe.closest(".iframe-fit__inner");
      if (innerParent && innerParent.parentElement?.classList.contains("iframe-fit")) {
        innerParent.parentElement.classList.add("iframe-shell");
        return innerParent.parentElement;
      }
      const wrapper = document.createElement("div");
      wrapper.className = "iframe-shell";
      const parent = iframe.parentNode;
      if (!parent) return null;
      parent.insertBefore(wrapper, iframe);
      wrapper.appendChild(iframe);
      return wrapper;
    };

    const getIframeRatio = (iframe) => {
      const attrW = parseFloat(iframe.getAttribute("width") || "");
      const attrH = parseFloat(iframe.getAttribute("height") || "");
      if (Number.isFinite(attrW) && Number.isFinite(attrH) && attrW > 0 && attrH > 0) {
        return (attrH / attrW) * 100;
      }
      return 56.25;
    };

    const applyIframeFit = (iframe, forceMobile) => {
      if (!iframe || iframe.closest(".md-diagram, .mermaid")) return;
      const isMobile = typeof forceMobile === "boolean" ? forceMobile : isMobileViewport();
      const wrapper = ensureIframeWrapper(iframe);
      if (!wrapper) return;
      if (!isMobile) {
        wrapper.classList.remove("iframe-fit");
        iframe.style.width = "";
        iframe.style.height = "";
        iframe.style.maxWidth = "";
        iframe.style.minHeight = "";
        iframe.style.maxHeight = "";
        iframe.style.aspectRatio = "";
        iframe.style.overflow = "";
        iframe.removeAttribute("scrolling");
        iframe.removeAttribute("data-sps-iframe-mobile");
        return;
      }

      wrapper.classList.add("iframe-fit");
      const ratio = getIframeRatio(iframe);
      wrapper.style.setProperty("--iframe-ratio", `${ratio}%`);
      iframe.style.maxWidth = "100%";
      iframe.style.minHeight = "0";
      iframe.style.maxHeight = "none";
      iframe.style.aspectRatio = "auto";
      iframe.style.width = "100%";
      iframe.style.height = "100%";
      iframe.style.overflow = "auto";
      iframe.removeAttribute("scrolling");
      iframe.setAttribute("data-sps-iframe-mobile", "1");
    };

    const fitMarkdownIframes = (container) => {
      const iframes = container.querySelectorAll("iframe");
      if (!iframes.length) return;
      const mobile = isMobileViewport();
      iframes.forEach((iframe) => applyIframeFit(iframe, mobile));
    };

    const iframeFullscreenWrappers = new Set();
    let iframeFullscreenListenerBound = false;

    const handleIframeFullscreenChange = () => {
      iframeFullscreenWrappers.forEach((wrapper) => {
        if (!wrapper.isConnected) {
          iframeFullscreenWrappers.delete(wrapper);
          return;
        }
        const button = wrapper.querySelector(".iframe-fullscreen-toggle");
        if (!button) return;
        const isFullscreen =
          document.fullscreenElement === wrapper ||
          document.fullscreenElement === wrapper.querySelector("iframe");
        button.setAttribute("aria-label", isFullscreen ? "退出全屏" : "全屏");
        button.setAttribute("title", isFullscreen ? "退出全屏" : "全屏");
        wrapper.classList.toggle("is-fullscreen", isFullscreen);
      });
    };

    const initIframeFullscreen = (container) => {
      const iframes = container.querySelectorAll("iframe");
      if (!iframes.length) return;
      iframes.forEach((iframe) => {
        const wrapper = ensureIframeWrapper(iframe);
        if (!wrapper) return;
        if (!iframe.hasAttribute("allowfullscreen")) {
          iframe.setAttribute("allowfullscreen", "");
        }
        const allowValue = iframe.getAttribute("allow") || "";
        if (!allowValue.includes("fullscreen")) {
          const nextValue = allowValue ? `${allowValue}; fullscreen` : "fullscreen";
          iframe.setAttribute("allow", nextValue);
        }
        if (wrapper.querySelector(".iframe-fullscreen-toggle")) return;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "iframe-fullscreen-toggle";
        button.setAttribute("aria-label", "全屏");
        button.setAttribute("title", "全屏");
        button.innerHTML =
          "<svg width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\" focusable=\"false\">" +
          "<path d=\"M3 7V5a2 2 0 0 1 2-2h2\" />" +
          "<path d=\"M17 3h2a2 2 0 0 1 2 2v2\" />" +
          "<path d=\"M7 21H5a2 2 0 0 1-2-2v-2\" />" +
          "<path d=\"M21 17v2a2 2 0 0 1-2 2h-2\" />" +
          "</svg>";
        button.addEventListener("click", async () => {
          if (document.fullscreenElement) {
            document.exitFullscreen().catch(() => {});
            return;
          }
          const requestFullscreen = iframe.requestFullscreen?.bind(iframe);
          if (requestFullscreen) {
            try {
              await requestFullscreen();
              return;
            } catch (err) {
              console.warn("iframe fullscreen failed, falling back to wrapper", err);
            }
          }
          wrapper.requestFullscreen?.().catch(() => {});
        });
        wrapper.appendChild(button);
        iframeFullscreenWrappers.add(wrapper);
        if (!iframeFullscreenListenerBound) {
          document.addEventListener("fullscreenchange", handleIframeFullscreenChange);
          iframeFullscreenListenerBound = true;
        }
        handleIframeFullscreenChange();
      });
    };

    const fitMarkdownVideos = (container) => {
      const mobile = isMobileViewport();
      container.querySelectorAll("video").forEach((video) => {
        if (!mobile) {
          if (video.dataset.spsVideoMobile === "1") {
            video.style.width = "";
            video.style.height = "";
            video.style.maxWidth = "";
            video.style.objectFit = "";
            video.style.display = "";
            video.removeAttribute("data-sps-video-mobile");
          }
          return;
        }
        if (video.dataset.spsVideoMobile === "1") return;
        video.dataset.spsVideoMobile = "1";
        video.style.width = "100%";
        video.style.height = "auto";
        video.style.maxWidth = "100%";
        video.style.objectFit = "contain";
        video.style.display = "block";
      });
    };

    document
      .querySelectorAll("textarea.markdown-source[data-md-id]")
      .forEach((source) => {
        const id = source.getAttribute("data-md-id");
        const target = document.querySelector(
          `.markdown-body[data-md-id="${id}"]`,
        );
        if (!target) return;
        const raw = source.value || "";
        target.innerHTML = md.render(raw);
        renderMindmap(target);
        renderEcharts(target);
        renderAbc(target);
        renderGraphviz(target);
        renderFlowchart(target);
        renderPlantUml(target);
        renderMermaidWithFonts(target);
        if (window.hljs) {
          target.querySelectorAll("pre code").forEach((block) => {
            if (block.closest(".md-diagram")) return;
            if (
              block.classList.contains("language-mermaid") ||
              block.classList.contains("lang-mermaid") ||
              block.classList.contains("mermaid")
            ) {
              return;
            }
            if (block.classList.contains("hljs")) {
              return;
            }
            window.hljs.highlightElement(block);
          });
        }
        decorateCodeBlocks(target);
        wrapScrollableMedia(target);
        fitMarkdownIframes(target);
        initIframeFullscreen(target);
        fitMarkdownVideos(target);
      });
  };

  const refreshShareDynamicContent = () => {
    initShareMarkdownToggle();
    initCommentEditors();
    initCommentModal();
    initReportModal();
    initDocTreeScroll();
    const token = ++shareDynamicToken;
    scheduleIdle(() => {
      if (token !== shareDynamicToken) return;
      try {
        initMarkdown();
      } catch (err) {
        console.error(err);
      }
      try {
        initShareToc();
      } catch (err) {
        console.error(err);
      }
    });
  };

  window.addEventListener(
    "sps:markdown-ready",
    () => {
      refreshShareDynamicContent();
    },
    {once: true},
  );
  window.addEventListener(
    "load",
    () => {
      if (typeof window.markdownit === "function") {
        refreshShareDynamicContent();
      }
    },
    {once: true},
  );

  initAnnouncementModal();
  initNav();
  initRangeSwitch();
  initAdminCharts();
  initKnowledgeTree();
  initBatchSelection();
  initUserModal();
  initUserCreateModal();
  initBatchConfirm();
  initToggleSubmit();
  initFormConfirm();
  initPaginationAutoSubmit();
  initFlashToast();
  initAdminCommentModal();
  initScanProgress();
  initShareSidebarTabs();
  initShareDrawer();
  initShareDocNavigation();
  initImageViewer();
  initAppDrawer();
  initScrollTop();
  initLoginTabs();
  initCountdownButtons();
  refreshShareDynamicContent();
})();
