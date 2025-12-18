(() => {
  const pgnFileInput = document.getElementById("pgnFile");
  const pgnPreview = document.getElementById("pgnPreview");
  const chatLog = document.getElementById("chatLog");
  const messageInput = document.getElementById("messageInput");
  const sendBtn = document.getElementById("sendBtn");
  const statusEl = document.getElementById("status");
  const personalitySelect = document.getElementById("personalitySelect");
  const reasoningLog = document.getElementById("reasoningLog");
  const reasoningSelect = document.getElementById("reasoningSelect");
  const pgnBoard = document.getElementById("pgnBoard");
  const pgnBoardCaption = document.getElementById("pgnBoardCaption");
  const pgnFirstBtn = document.getElementById("pgnFirstBtn");
  const pgnPrevBtn = document.getElementById("pgnPrevBtn");
  const pgnNextBtn = document.getElementById("pgnNextBtn");
  const pgnLastBtn = document.getElementById("pgnLastBtn");
  const pgnMoveInfo = document.getElementById("pgnMoveInfo");

  let currentPgnText = "";
  let currentCoachMarkdown = "";
  /** @type {Array<{ index: number, fen: string, ply: number, san: string | null, moveNumber: number, color: string }>} */
  let currentPgnPositions = [];
  let currentPgnIndex = 0;
  let currentReasoningBlock = null;
  let reasoningSentenceBuffer = "";

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

  function renderBoardFromFen(fen, options = {}) {
    if (!pgnBoard) return;

    const { captionOverride } = options;

    pgnBoard.innerHTML = "";

    if (!fen || typeof fen !== "string") {
      if (pgnBoardCaption) {
        pgnBoardCaption.textContent =
          captionOverride || "No PGN loaded yet.";
      }
      return;
    }

    const parts = fen.split(" ");
    if (!parts[0]) {
      if (pgnBoardCaption) {
        pgnBoardCaption.textContent =
          captionOverride || "Could not parse PGN position.";
      }
      return;
    }

    const rows = parts[0].split("/");
    if (rows.length !== 8) {
      if (pgnBoardCaption) {
        pgnBoardCaption.textContent =
          captionOverride || "Could not parse PGN position.";
      }
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

    renderBoardFromFen(node.fen, {
      captionOverride:
        currentPgnIndex === maxIndex
          ? `Final position from PGN • ${node.color || ""} to move`
          : `${node.color || ""} to move (after move ${currentPgnIndex})`,
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

      if (list.length > 0) {
        addMessage(
          "system",
          "Loaded Rodent personalities. Select one to adjust the coach's tone."
        );
      }
    } catch (err) {
      console.error("Failed to load personalities:", err);
      addMessage(
        "system",
        "Could not load Rodent personalities; using default coach tone."
      );
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
        addMessage("system", `Loaded PGN file: ${file.name}`);
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

  if (personalitySelect) {
    personalitySelect.addEventListener("change", () => {
      const value = personalitySelect.value;
      if (!value) {
        addMessage("system", "Using default coach personality.");
      } else {
        const label =
          personalitySelect.options[personalitySelect.selectedIndex].textContent;
        addMessage("system", `Using coach personality: ${label}`);
      }
    });
  }

  if (reasoningSelect) {
    reasoningSelect.addEventListener("change", () => {
      const value = reasoningSelect.value || "none";
      addMessage("system", `Reasoning effort: ${value}`);
    });
  }

  async function sendQuestion() {
    const question = messageInput.value.trim();

    if (!currentPgnText) {
      alert("Please upload a PGN file first.");
      return;
    }

    if (question.length > 0) {
      addMessage("user", question);
    } else {
      addMessage("user", "(no specific question, asking for general explanation)");
    }

    messageInput.value = "";
    setStatus("Coach is thinking...");
    sendBtn.disabled = true;

    // Reset reasoning view for this new request.
    if (reasoningLog) {
      reasoningLog.textContent = "";
    }
    currentReasoningBlock = null;
    reasoningSentenceBuffer = "";

    // Create an empty coach bubble we will fill sentence-by-sentence.
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

    try {
      const response = await fetch("/api/chat/stream", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          pgnText: currentPgnText,
          message: question,
          personalityId: selectedPersonality,
          reasoningEffort: selectedReasoning,
        }),
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
              setStatus("Coach is thinking...");
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
              console.debug("Coach reasoning:", evt.text);
              appendReasoningChunk(evt.text);
            }
          } else if (evt.type === "error") {
            const msg = evt.message || "Unknown streaming error.";
            addMessage("system", "Error from coach: " + msg);
          }
        }
      }

      // Flush any remaining partial reasoning sentence once the stream ends.
      flushReasoningSentenceIfAny();
    } catch (err) {
      console.error(err);
      addMessage("system", "Error contacting coach: " + err.message);
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

  if (messageInput) {
    messageInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void sendQuestion();
      }
    });
  }

  void loadPersonalities();
})();
