(() => {
  const pgnFileInput = document.getElementById("pgnFile");
  const pgnPreview = document.getElementById("pgnPreview");
  const chatLog = document.getElementById("chatLog");
  const sendBtn = document.getElementById("sendBtn");
  const statusEl = document.getElementById("status");
  const personalitySelect = document.getElementById("personalitySelect");
  const reasoningLog = document.getElementById("reasoningLog");
  const engineLog = document.getElementById("engineLog");
  const reasoningSelect = document.getElementById("reasoningSelect");
  const useTauntMode = document.getElementById("useTauntMode");
  const llmSourceSelect = document.getElementById("llmSourceSelect");
  const llmLanHostInput = document.getElementById("llmLanHost");
  const llmLanPortInput = document.getElementById("llmLanPort");
  const llmLanRow = document.getElementById("llmLanRow");
  const remoteFallbackToggle = document.getElementById("remoteFallbackToggle");
  const remoteFallbackRow = document.getElementById("remoteFallbackRow");
  const playerColorSelect = document.getElementById("playerColorSelect");
  // Comment target is now always the human player's move for taunts; the
  // legacy coach commentTargetSelect control has been removed from the UI.
  const pgnBoardContainer = document.getElementById("pgnBoardContainer");
  const pgnBoard = document.getElementById("pgnBoard");
  const pgnBoardCaption = document.getElementById("pgnBoardCaption");
  const pgnFirstBtn = document.getElementById("pgnFirstBtn");
  const pgnPrevBtn = document.getElementById("pgnPrevBtn");
  const pgnNextBtn = document.getElementById("pgnNextBtn");
  const pgnLastBtn = document.getElementById("pgnLastBtn");
  const pgnMoveInfo = document.getElementById("pgnMoveInfo");
  const headerEl = document.querySelector(".header");
  const inputSectionToggleBtn = document.getElementById("inputSectionToggleBtn");

  const SVG_NS = "http://www.w3.org/2000/svg";

  let currentPgnText = "";
  let currentCoachMarkdown = "";
  /**
   * @type {Array<{
   *   index: number,
   *   fen: string,
   *   ply: number,
   *   san: string | null,
   *   moveNumber: number,
   *   color: string,
   *   lastMove: { from: string, to: string } | null
   * }>}
   */
  let currentPgnPositions = [];
  let currentPgnIndex = 0;
  let currentReasoningBlock = null;
  let reasoningSentenceBuffer = "";
  let pgnArrowSvg = null;

  const SHOW_DIAGNOSTIC_SYSTEM_MESSAGES = false;
  let inputSectionCollapsed = false;

  function pieceCodeFromSymbol(symbol) {
    if (!symbol || typeof symbol !== "string") return "";
    const s = symbol.trim();
    if (!s) return "";

    const lower = s.toLowerCase();
    if (!"pnbrqk".includes(lower)) return "";

    const isWhite = s === s.toUpperCase();
    const colorCode = isWhite ? "w" : "b";
    const typeCode = lower.toUpperCase(); // p -> P, n -> N, ...
    return colorCode + typeCode; // e.g., wP, bK
  }

  function squareIsDark(fileIndex, rank) {
    // Use standard chessboard coloring: a1 is dark, h1 is light.
    const fileNumber = fileIndex + 1; // a=1, b=2, ...
    const rankNumber = rank; // 1..8 from White's perspective
    return (fileNumber + rankNumber) % 2 === 0;
  }

  function normalizeSquare(square) {
    if (!square || typeof square !== "string") return null;
    const s = square.trim().toLowerCase();
    if (!/^[a-h][1-8]$/.test(s)) return null;
    return s;
  }

  function squareCenterPoint(square, boardWidth, boardHeight) {
    const s = normalizeSquare(square);
    if (!s) return null;

    const fileIndex = s.charCodeAt(0) - "a".charCodeAt(0); // 0..7
    const rank = parseInt(s[1], 10); // 1..8
    if (!Number.isFinite(rank) || rank < 1 || rank > 8) return null;

    const x = ((fileIndex + 0.5) / 8) * boardWidth;
    const rowIndexFromTop = 8 - rank; // rank 8 -> row 0
    const y = ((rowIndexFromTop + 0.5) / 8) * boardHeight;
    return { x, y };
  }

  function squareRect(square, boardWidth, boardHeight) {
    const s = normalizeSquare(square);
    if (!s) return null;

    const fileIndex = s.charCodeAt(0) - "a".charCodeAt(0); // 0..7
    const rank = parseInt(s[1], 10); // 1..8
    if (!Number.isFinite(rank) || rank < 1 || rank > 8) return null;

    const cellWidth = boardWidth / 8;
    const cellHeight = boardHeight / 8;
    const rowIndexFromTop = 8 - rank; // rank 8 -> row 0

    return {
      x: fileIndex * cellWidth,
      y: rowIndexFromTop * cellHeight,
      width: cellWidth,
      height: cellHeight,
    };
  }

  function clearLastMoveArrow() {
    if (pgnArrowSvg && pgnArrowSvg.parentNode) {
      pgnArrowSvg.parentNode.removeChild(pgnArrowSvg);
    }
    pgnArrowSvg = null;
  }

  function drawLastMoveArrow(lastMove) {
    if (!pgnBoardContainer || !pgnBoard) return;

    if (!lastMove || !lastMove.from || !lastMove.to) {
      clearLastMoveArrow();
      return;
    }

    const boardRect = pgnBoard.getBoundingClientRect();
    const containerRect = pgnBoardContainer.getBoundingClientRect();
    const width = boardRect.width || pgnBoard.clientWidth;
    const height = boardRect.height || pgnBoard.clientHeight;

    if (!width || !height) {
      clearLastMoveArrow();
      return;
    }

    const fromPoint = squareCenterPoint(lastMove.from, width, height);
    const toPoint = squareCenterPoint(lastMove.to, width, height);
    if (!fromPoint || !toPoint) {
      clearLastMoveArrow();
      return;
    }

    if (!pgnArrowSvg) {
      pgnArrowSvg = document.createElementNS(SVG_NS, "svg");
      pgnArrowSvg.setAttribute("class", "pgn-last-move-arrow");
      pgnBoardContainer.appendChild(pgnArrowSvg);
    }

    pgnArrowSvg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    pgnArrowSvg.setAttribute("preserveAspectRatio", "none");
    pgnArrowSvg.style.left = `${boardRect.left - containerRect.left}px`;
    pgnArrowSvg.style.top = `${boardRect.top - containerRect.top}px`;
    pgnArrowSvg.style.width = `${width}px`;
    pgnArrowSvg.style.height = `${height}px`;
    pgnArrowSvg.innerHTML = "";

    const arrowColor = "#f6b040";

    // Highlight origin and destination squares with a soft overlay.
    const fromRect = squareRect(lastMove.from, width, height);
    const toRect = squareRect(lastMove.to, width, height);

    const highlightOpacity = 0.45;

    if (fromRect) {
      const fromHighlight = document.createElementNS(SVG_NS, "rect");
      fromHighlight.setAttribute("x", String(fromRect.x));
      fromHighlight.setAttribute("y", String(fromRect.y));
      fromHighlight.setAttribute("width", String(fromRect.width));
      fromHighlight.setAttribute("height", String(fromRect.height));
      fromHighlight.setAttribute("fill", arrowColor);
      fromHighlight.setAttribute("fill-opacity", String(highlightOpacity));
      fromHighlight.setAttribute("stroke", "none");
      pgnArrowSvg.appendChild(fromHighlight);
    }

    if (toRect) {
      const toHighlight = document.createElementNS(SVG_NS, "rect");
      toHighlight.setAttribute("x", String(toRect.x));
      toHighlight.setAttribute("y", String(toRect.y));
      toHighlight.setAttribute("width", String(toRect.width));
      toHighlight.setAttribute("height", String(toRect.height));
      toHighlight.setAttribute("fill", arrowColor);
      toHighlight.setAttribute("fill-opacity", String(highlightOpacity));
      toHighlight.setAttribute("stroke", "none");
      pgnArrowSvg.appendChild(toHighlight);
    }

    const defs = document.createElementNS(SVG_NS, "defs");
    const marker = document.createElementNS(SVG_NS, "marker");
    marker.setAttribute("id", "pgnArrowHead");
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("markerWidth", "12");
    marker.setAttribute("markerHeight", "12");
    marker.setAttribute("refX", "9");
    marker.setAttribute("refY", "5");
    marker.setAttribute("orient", "auto");
    marker.setAttribute("markerUnits", "userSpaceOnUse");

    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", "M0,0 L0,10 L10,5 z");
    path.setAttribute("fill", arrowColor);
    path.setAttribute("stroke", "none");

    marker.appendChild(path);
    defs.appendChild(marker);
    pgnArrowSvg.appendChild(defs);

    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", String(fromPoint.x));
    line.setAttribute("y1", String(fromPoint.y));
    line.setAttribute("x2", String(toPoint.x));
    line.setAttribute("y2", String(toPoint.y));

    const thickness = Math.max(width, height) * 0.02;
    line.setAttribute("stroke", arrowColor);
    line.setAttribute("stroke-width", String(thickness));
    line.setAttribute("stroke-linecap", "round");
    line.setAttribute("marker-end", "url(#pgnArrowHead)");

    pgnArrowSvg.appendChild(line);
  }

  function renderBoardFromFen(fen, options = {}) {
    if (!pgnBoard) return;

    const { captionOverride, lastMove } = options;

    pgnBoard.innerHTML = "";

    if (!fen || typeof fen !== "string") {
      if (pgnBoardCaption) {
        pgnBoardCaption.textContent =
          captionOverride || "No PGN loaded yet.";
      }
      clearLastMoveArrow();
      return;
    }

    const parts = fen.split(" ");
    if (!parts[0]) {
      if (pgnBoardCaption) {
        pgnBoardCaption.textContent =
          captionOverride || "Could not parse PGN position.";
      }
      clearLastMoveArrow();
      return;
    }

    const rows = parts[0].split("/");
    if (rows.length !== 8) {
      if (pgnBoardCaption) {
        pgnBoardCaption.textContent =
          captionOverride || "Could not parse PGN position.";
      }
      clearLastMoveArrow();
      return;
    }

    const sideToMove = parts[1] === "w" ? "White" : "Black";

    let rank = 8;
    for (let r = 0; r < 8; r += 1) {
      const row = rows[r];
      let fileIndex = 0;

      for (const ch of row) {
        if (fileIndex >= 8) break;

        if (/[1-8]/.test(ch)) {
          const emptyCount = parseInt(ch, 10);
          for (let i = 0; i < emptyCount && fileIndex < 8; i += 1) {
            const sq = document.createElement("div");
            sq.className =
              "chess-square " +
              (squareIsDark(fileIndex, rank)
                ? "chess-square--dark"
                : "chess-square--light");
            pgnBoard.appendChild(sq);
            fileIndex += 1;
          }
        } else {
          const sq = document.createElement("div");
          let baseClass =
            "chess-square " +
            (squareIsDark(fileIndex, rank)
              ? "chess-square--dark"
              : "chess-square--light");

          const pieceCode = pieceCodeFromSymbol(ch);
          if (pieceCode) {
            baseClass += " " + "piece-" + pieceCode;
          }

          sq.className = baseClass;
          pgnBoard.appendChild(sq);
          fileIndex += 1;
        }
      }

      rank -= 1;
    }

    drawLastMoveArrow(lastMove || null);

    if (pgnBoardCaption) {
      pgnBoardCaption.textContent =
        captionOverride ||
        `${sideToMove} to move • FEN: ${fen}`;
    }
  }

  function updatePgnMoveInfo() {
    if (!pgnMoveInfo) return;

    const total = currentPgnPositions.length > 0
      ? currentPgnPositions.length - 1
      : 0;

    const clampedIndex = Math.max(0, Math.min(currentPgnIndex, total));
    const node = currentPgnPositions[clampedIndex];

    if (!node) {
      pgnMoveInfo.textContent = "Move 0 / 0";
      return;
    }

    const moveNumber = node.moveNumber || 0;
    const san = node.san || (clampedIndex === 0 ? "(start position)" : "");
    pgnMoveInfo.textContent = `Move ${clampedIndex} / ${total}${
      san ? ` • ${san}` : ""
    }`;
  }

  function showPgnPosition(index) {
    if (!Array.isArray(currentPgnPositions) || currentPgnPositions.length === 0) {
      return;
    }

    const maxIndex = currentPgnPositions.length - 1;
    currentPgnIndex = Math.max(0, Math.min(index, maxIndex));

    const node = currentPgnPositions[currentPgnIndex];
    if (!node || !node.fen) return;

    // Determine the side to move from the FEN itself instead of relying on
    // the move color stored in the positions array. The FEN's second field
    // is "w" or "b", which directly encodes whose turn it is.
    let sideToMoveLabel = "";
    if (typeof node.fen === "string") {
      const parts = node.fen.split(" ");
      if (parts[1] === "b") {
        sideToMoveLabel = "Black";
      } else if (parts[1] === "w") {
        sideToMoveLabel = "White";
      }
    }

    renderBoardFromFen(node.fen, {
      captionOverride:
        currentPgnIndex === maxIndex
          ? `Final position from PGN • ${sideToMoveLabel || ""} to move`
          : `${sideToMoveLabel || ""} to move (after move ${currentPgnIndex})`,
      lastMove: node.lastMove || null,
    });
    updatePgnMoveInfo();
  }

  async function updatePgnBoardFromPgn(pgnText) {
    if (!pgnText || typeof pgnText !== "string") {
      renderBoardFromFen("", { captionOverride: "No PGN loaded yet." });
      return;
    }
    try {
      const res = await fetch("/api/pgn/final-position", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ pgnText }),
      });

      if (!res.ok) {
        let msg = "Could not parse PGN; showing raw text below.";
        try {
          const data = await res.json();
          if (data && data.error) msg = data.error;
        } catch {
          // ignore JSON parse errors
        }
        renderBoardFromFen("", {
          captionOverride: msg,
        });
        return;
      }

      const data = await res.json();
      if (!data || !data.fen) {
        renderBoardFromFen("", {
          captionOverride: "PGN parsed, but no position returned.",
        });
        return;
      }
      currentPgnPositions = Array.isArray(data.positions) ? data.positions : [];
      currentPgnIndex = currentPgnPositions.length > 0 ? currentPgnPositions.length - 1 : 0;
      showPgnPosition(currentPgnIndex);
    } catch (err) {
      console.error("Failed to render PGN board:", err);
      renderBoardFromFen("", {
        captionOverride: "Error reading PGN; showing raw text below.",
      });
    }
  }

  function setStatus(text) {
    statusEl.textContent = text || "";
  }

  function setInputSectionCollapsed(collapsed) {
    inputSectionCollapsed = !!collapsed;
    if (!headerEl || !inputSectionToggleBtn) return;

    if (inputSectionCollapsed) {
      headerEl.classList.add("header--collapsed");
      inputSectionToggleBtn.textContent = "Show setup";
      inputSectionToggleBtn.setAttribute("aria-expanded", "false");
    } else {
      headerEl.classList.remove("header--collapsed");
      inputSectionToggleBtn.textContent = "Hide setup";
      inputSectionToggleBtn.setAttribute("aria-expanded", "true");
    }
  }

  function addMessage(role, text) {
    const div = document.createElement("div");
    div.className = `msg msg-${role}`;
    div.textContent = text;
    chatLog.appendChild(div);
    chatLog.scrollTop = chatLog.scrollHeight;
    return div;
  }

  function renderMarkdown(markdown) {
    if (window.marked && typeof window.marked.parse === "function") {
      return window.marked.parse(markdown);
    }

    // Fallback: escape and convert newlines to <br> so streaming still looks ok.
    const temp = document.createElement("div");
    temp.textContent = markdown;
    return temp.innerHTML.replace(/\n/g, "<br>");
  }

  function flushReasoningSentenceIfAny() {
    if (!reasoningLog) return;
    const raw = reasoningSentenceBuffer;
    if (!raw) return;

    // Reuse a single block per request so reasoning appears as a continuous
    // stream instead of one line per packet.
    if (!currentReasoningBlock) {
      currentReasoningBlock = document.createElement("div");
      currentReasoningBlock.className = "reasoning-entry";
      currentReasoningBlock.textContent = raw;
      reasoningLog.appendChild(currentReasoningBlock);
    } else {
      currentReasoningBlock.textContent += raw;
    }

    reasoningSentenceBuffer = "";
    reasoningLog.scrollTop = reasoningLog.scrollHeight;
  }

  function appendEngineDebug(text) {
    if (!engineLog || !text) return;
    const block = document.createElement("pre");
    block.className = "reasoning-entry";
    block.textContent = text;
    engineLog.appendChild(block);
    engineLog.scrollTop = engineLog.scrollHeight;
  }

  if (inputSectionToggleBtn) {
    inputSectionToggleBtn.addEventListener("click", () => {
      setInputSectionCollapsed(!inputSectionCollapsed);
    });
    // Ensure initial state matches the DOM.
    setInputSectionCollapsed(false);
  }

  function appendReasoningChunk(text) {
    if (!reasoningLog || !text) return;

    // Buffer reasoning until we reach sentence boundaries, but do not introduce
    // any extra line breaks; we simply append the model's raw text.
    for (const ch of text) {
      reasoningSentenceBuffer += ch;
      if (ch === "." || ch === "!" || ch === "?" || ch === "\n") {
        flushReasoningSentenceIfAny();
      }
    }
  }

  async function loadPersonalities() {
    if (!personalitySelect) return;

    try {
      const res = await fetch("/api/personalities");
      if (!res.ok) {
        throw new Error("HTTP " + res.status);
      }

      const list = await res.json();
      if (!Array.isArray(list)) return;

      // Preserve the first (default) option.
      while (personalitySelect.options.length > 1) {
        personalitySelect.remove(1);
      }

      for (const item of list) {
        if (!item || !item.id) continue;
        const opt = document.createElement("option");
        opt.value = item.id;
        if (item.elo) {
          opt.textContent = `${item.id} (${item.elo})`;
        } else {
          opt.textContent = item.id;
        }
        if (item.description) {
          opt.title = item.description;
        }
        personalitySelect.appendChild(opt);
      }

      if (list.length > 0 && SHOW_DIAGNOSTIC_SYSTEM_MESSAGES) {
        addMessage(
          "system",
          "Loaded Rodent personalities. Select one to adjust the taunt style."
        );
      }
    } catch (err) {
      console.error("Failed to load personalities:", err);
      if (SHOW_DIAGNOSTIC_SYSTEM_MESSAGES) {
        addMessage(
          "system",
          "Could not load Rodent personalities; using default coach tone."
        );
      }
    }
  }

  if (pgnFileInput) {
    pgnFileInput.addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = () => {
        currentPgnText = String(reader.result || "");
        pgnPreview.value = currentPgnText.slice(0, 4000);
        if (SHOW_DIAGNOSTIC_SYSTEM_MESSAGES) {
          addMessage("system", `Loaded PGN file: ${file.name}`);
        }
        updatePgnBoardFromPgn(currentPgnText);
      };
      reader.onerror = () => {
        setStatus("Failed to read PGN file.");
      };
      reader.readAsText(file);
    });
  }

  function bindPgnNavButton(btn, computeIndex) {
    if (!btn) return;
    btn.addEventListener("click", () => {
      if (!Array.isArray(currentPgnPositions) || currentPgnPositions.length === 0) {
        return;
      }
      const nextIndex = computeIndex(
        currentPgnIndex,
        currentPgnPositions.length
      );
      showPgnPosition(nextIndex);
    });
  }

  bindPgnNavButton(pgnFirstBtn, () => 0);
  bindPgnNavButton(pgnPrevBtn, (idx) => idx - 1);
  bindPgnNavButton(pgnNextBtn, (idx, len) => Math.min(len - 1, idx + 1));
  bindPgnNavButton(pgnLastBtn, (idx, len) => len - 1);

  // Keep the last-move arrow aligned with the board on window resize.
  if (typeof window !== "undefined") {
    window.addEventListener("resize", () => {
      if (
        !Array.isArray(currentPgnPositions) ||
        currentPgnPositions.length === 0
      ) {
        clearLastMoveArrow();
        return;
      }
      const node = currentPgnPositions[currentPgnIndex] || null;
      if (node && node.lastMove) {
        drawLastMoveArrow(node.lastMove);
      } else {
        clearLastMoveArrow();
      }
    });
  }

  if (personalitySelect) {
    personalitySelect.addEventListener("change", () => {
      const value = personalitySelect.value;
      if (SHOW_DIAGNOSTIC_SYSTEM_MESSAGES) {
        if (!value) {
          addMessage("system", "Using default taunt style.");
        } else {
          const label =
            personalitySelect.options[personalitySelect.selectedIndex].textContent;
          addMessage("system", `Using taunt character: ${label}`);
        }
      }
    });
  }

  if (reasoningSelect) {
    reasoningSelect.addEventListener("change", () => {
      const value = reasoningSelect.value || "none";
      if (SHOW_DIAGNOSTIC_SYSTEM_MESSAGES) {
        addMessage("system", `Reasoning effort: ${value}`);
      }
    });
  }

  if (llmSourceSelect && llmLanRow) {
    llmSourceSelect.addEventListener("change", () => {
      const value = llmSourceSelect.value || "local";
      if (value === "lan") {
        llmLanRow.classList.remove("llm-lan-row--hidden");
      } else {
        llmLanRow.classList.add("llm-lan-row--hidden");
      }

      let label = "";
      if (value === "local") {
        label = "LLM source: Local (localhost / default config).";
      } else if (value === "lan") {
        label = "LLM source: LAN (custom IP/port).";
      } else if (value === "remote") {
        label = "LLM source: Remote (OpenRouter).";
      }
      if (label && SHOW_DIAGNOSTIC_SYSTEM_MESSAGES) {
        addMessage("system", label);
      }

      if (remoteFallbackRow && remoteFallbackToggle) {
        // Remote fallback is only meaningful when using Local or LAN.
        const enableFallback = value === "local" || value === "lan";
        remoteFallbackToggle.disabled = !enableFallback;
        if (!enableFallback) {
          remoteFallbackToggle.checked = false;
        }
      }
    });
  }

  async function sendQuestion() {
    if (!currentPgnText) {
      alert("Please upload a PGN file first.");
      return;
    }

    setStatus("Generating taunt...");
    sendBtn.disabled = true;

    // Reset reasoning view for this new request.
    if (reasoningLog) {
      reasoningLog.textContent = "";
    }
    if (engineLog) {
      engineLog.textContent = "";
    }
    currentReasoningBlock = null;
    reasoningSentenceBuffer = "";

    // Create an empty taunt bubble we will fill sentence-by-sentence.
    const coachDiv = addMessage("coach", "");
    currentCoachMarkdown = "";

    const selectedPersonality =
      personalitySelect && personalitySelect.value
        ? personalitySelect.value
        : "";

    const selectedReasoning =
      reasoningSelect && reasoningSelect.value
        ? reasoningSelect.value
        : "none";

    const selectedLlmSource =
      llmSourceSelect && llmSourceSelect.value
        ? llmSourceSelect.value
        : "local";

    const remoteFallbackEnabled =
      remoteFallbackToggle && !remoteFallbackToggle.disabled
        ? !!remoteFallbackToggle.checked
        : false;

    const lanHost =
      llmLanHostInput && llmLanHostInput.value
        ? llmLanHostInput.value.trim()
        : "";
    const lanPort =
      llmLanPortInput && llmLanPortInput.value
        ? llmLanPortInput.value.trim()
        : "";

    const selectedPlayerColor =
      playerColorSelect && playerColorSelect.value
        ? playerColorSelect.value
        : "white";

    try {
      const endpoint = "/api/taunt/stream";

      const payload = {
        pgnText: currentPgnText,
        tauntTargetSide: "player",
        playerColor: selectedPlayerColor,
        characterId: selectedPersonality,
        reasoningEffort: selectedReasoning,
        // We no longer collect a free-form user question; taunts are generated
        // purely from engine + game-state details.
        playerMessage: "",
        llmSource: selectedLlmSource,
        lanHost,
        lanPort,
        remoteFallback: remoteFallbackEnabled,
      };

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok || !response.body) {
        let msg = "Request failed.";
        try {
          const data = await response.json();
          if (data && data.error) msg = data.error;
        } catch {
          // ignore JSON errors
        }
        addMessage("system", `Error: ${msg}`);
        setStatus("");
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      // Read newline-delimited JSON events from the stream.
      // { type: "typing", state: "start" | "end" }
      // { type: "sentence", text: "..." }
      // { type: "error", message: "..." }
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        let newlineIndex;
        while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (!line) continue;

          let evt;
          try {
            evt = JSON.parse(line);
          } catch {
            continue;
          }

          if (evt.type === "typing") {
            if (evt.state === "start") {
              setStatus("Generating taunt...");
            } else if (evt.state === "end") {
              setStatus("");
            }
          } else if (evt.type === "sentence") {
            if (coachDiv && typeof evt.text === "string" && evt.text.length > 0) {
              // Append the streamed chunk verbatim so we preserve the model's
              // original line breaks and spacing instead of inventing extra
              // newlines between "sentences".
              currentCoachMarkdown += evt.text;
              coachDiv.innerHTML = renderMarkdown(currentCoachMarkdown);
              chatLog.scrollTop = chatLog.scrollHeight;
            }
          } else if (evt.type === "reasoning") {
            // Dev-only: show reasoning in the separate panel and log to console.
            if (evt.text && typeof evt.text === "string") {
              console.debug("Taunt reasoning:", evt.text);
              appendReasoningChunk(evt.text);
            }
          } else if (evt.type === "engine_debug") {
            if (evt.text && typeof evt.text === "string") {
              appendEngineDebug(evt.text);
            }
          } else if (evt.type === "error") {
            const msg = evt.message || "Unknown streaming error.";
            addMessage("system", "Error from taunt service: " + msg);
          }
        }
      }

      // Flush any remaining partial reasoning sentence once the stream ends.
      flushReasoningSentenceIfAny();
    } catch (err) {
      console.error(err);
      addMessage("system", "Error contacting taunt service: " + err.message);
      setStatus("");
    } finally {
      sendBtn.disabled = false;
    }
  }

  if (sendBtn) {
    sendBtn.addEventListener("click", () => {
      void sendQuestion();
    });
  }

  void loadPersonalities();
})();
