/**
 * Desktop fat-fish pet — client half.
 *
 * A click-through floating overlay registered into the shell's `shell.overlay`
 * slot, anchored to the bottom-right corner of the GUI.
 *
 * Hard rules this file exists to honour:
 *   - never affect normal harness use: no host event subscription, no approval
 *     or question interception, no writes into harness state, and every failure
 *     degrades to "no pet" rather than an exception in the page;
 *   - never cost the user background: at most one decoded `<video>` at a time,
 *     no polling loop, no timer while the page is hidden, no network egress
 *     (the only requests are same-origin asset fetches served by our own host
 *     half).
 *
 * Hand-written in the lazy-CJS shape the shell's module loader expects, so it
 * must not contain `import`/`export`, and it cannot require sibling files: all
 * client code lives here. Pure helpers are re-exported under `__test` so the
 * Node test suite can exercise them through the same loader stub the shell uses.
 */
window.__ModuleLoader__.load({
	id: "@local/dsh-pet",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		let React = require("react");

		// ---------------------------------------------------------------- consts

		var FALLBACK_BASE = "/dsh-pet";
		var STORAGE_KEY = "dsh-pet.v1";
		var DEBUG_KEY = "__DSH_PET_DEBUG__";
		/** Trailing debounce for persisting settings while the user drags a control. */
		var SAVE_DEBOUNCE_MS = 250;
		/**
		 * The pet's display size is fixed on purpose: a size slider only raised the
		 * question of what the right size is, and every change costs a re-anchor.
		 * 0.5 of the 640x360 canvas = 320px wide.
		 */
		var FIXED_SCALE = 0.5;

		/** Last-resort phrases: the pet must still talk if clips.json is unavailable. */
		var FALLBACK_PHRASES = [
			"写代码好累呀…",
			"要不要休息一下？",
			"我一直在这儿陪着你。",
			"这一段写完就去喝口水吧。",
			"嗯…这个 bug 有点意思。",
			"摸摸头，慢慢来。"
		];

		var DEFAULTS = {
			enabled: true,
			selfTalk: true,
			selfTalkMinMs: 20000,
			selfTalkMaxMs: 60000,
			bubbleTextScale: 100,
			bubbles: true,
			// "off" keeps the pet on a static frame between interactions. Continuous
			// VP9 alpha decoding costs ~34% of a core, so the budget-friendly default
			// is the one that decodes nothing while idle.
			idleAnimation: "off"
		};

		// ---------------------------------------------------------------- helpers

		function clamp(value, low, high) {
			if (!Number.isFinite(value)) return low;
			return Math.min(high, Math.max(low, value));
		}

		/** Cumulative-threshold animation chain, mirroring the desktop original. */
		function pickCategory(roll, chain) {
			var r = clamp(roll, 0, 0.999999);
			var levels = chain || { idle: 0.3, turn: 0.4, act: 0.8, move: 1 };
			if (r < levels.idle) return "idle";
			if (r < levels.turn) return "turn";
			if (r < levels.act) return "act";
			return "move";
		}

		/** Desktop parity: 1200ms + 60ms per character, clamped to [2.5s, 8s]. */
		function bubbleDurationMs(text) {
			var length = String(text || "").length;
			return clamp(1200 + 60 * length, 2500, 8000);
		}

		/** Snap a distance to whole strides so the walk never skates. */
		function quantizeMove(distancePx, stridePx) {
			var stride = Number(stridePx);
			if (!Number.isFinite(stride) || stride <= 0) return distancePx;
			var steps = Math.round(distancePx / stride);
			if (steps === 0) steps = distancePx >= 0 ? 1 : -1;
			return steps * stride;
		}

		function randomBetween(low, high, random) {
			var r = typeof random === "function" ? random() : Math.random();
			return low + (high - low) * clamp(r, 0, 1);
		}

		function pickOne(list, random) {
			if (!Array.isArray(list) || list.length === 0) return null;
			var r = typeof random === "function" ? random() : Math.random();
			return list[Math.min(list.length - 1, Math.floor(clamp(r, 0, 0.999999) * list.length))];
		}

		function readSettings(raw) {
			var parsed = null;
			try {
				parsed = raw ? JSON.parse(raw) : null;
			} catch (error) {
				parsed = null;
			}
			var merged = {};
			Object.keys(DEFAULTS).forEach(function (key) {
				merged[key] = DEFAULTS[key];
			});
			if (parsed !== null && typeof parsed === "object") {
				Object.keys(DEFAULTS).forEach(function (key) {
					var value = parsed[key];
					if (key === "bubbleTextScale") merged.bubbleTextScale = clamp(Number(value), 50, 300);
					else if (key === "selfTalkMinMs") merged.selfTalkMinMs = clamp(Number(value), 3000, 600000);
					else if (key === "selfTalkMaxMs") merged.selfTalkMaxMs = clamp(Number(value), 3000, 600000);
					else if (key === "idleAnimation") {
						merged.idleAnimation = value === "always" || value === "low" ? value : "off";
					} else if (typeof value === "boolean") merged[key] = value;
				});
			}
			if (merged.selfTalkMaxMs < merged.selfTalkMinMs) merged.selfTalkMaxMs = merged.selfTalkMinMs;
			return merged;
		}

		/** Validate and index the clip description produced by tools/build_assets.py. */
		function parseClips(payload) {
			if (payload === null || typeof payload !== "object") return null;
			if (!Array.isArray(payload.clips) || payload.clips.length === 0) return null;
			var byCategory = { idle: [], turn: [], move: [], click: [], drag: [], random: [] };
			var byId = {};
			// Only well-formed entries are published: a caller iterating `clips`
			// must never meet an entry without a file.
			var clean = [];
			payload.clips.forEach(function (clip) {
				if (clip === null || typeof clip !== "object") return;
				if (typeof clip.id !== "string" || typeof clip.file !== "string") return;
				var category = typeof clip.category === "string" ? clip.category : "random";
				if (!Object.prototype.hasOwnProperty.call(byCategory, category)) byCategory[category] = [];
				byCategory[category].push(clip);
				byId[clip.id] = clip;
				clean.push(clip);
			});
			if (byCategory.idle.length === 0) return null;
			// The one still frame the pet rests on. Inlined by the asset pipeline so
			// the browser never issues an image request — a request that a host whose
			// allow-list predates the extension would answer with a 404, which Chrome
			// paints as a bordered broken-image placeholder (the white box).
			var idlePoster = null;
			if (typeof payload.idle_poster === "string") idlePoster = payload.idle_poster;
			else if (typeof byCategory.idle[0].poster === "string") idlePoster = byCategory.idle[0].poster;
			return {
				clips: clean,
				idlePoster: idlePoster,
				byCategory: byCategory,
				byId: byId,
				canvas: Array.isArray(payload.canvas) ? payload.canvas : [640, 360],
				bodyBox: Array.isArray(payload.body_box) ? payload.body_box : [0, 0, 640, 360],
				scaleSteps: Array.isArray(payload.scale_steps) ? payload.scale_steps : [0.72],
				defaultScale: typeof payload.default_scale === "number" ? payload.default_scale : 0.72,
				cornerMargin: typeof payload.corner_margin === "number" ? payload.corner_margin : 24,
				dragThreshold: typeof payload.drag_threshold === "number" ? payload.drag_threshold : 5,
				moveMinPx: typeof payload.move_min_px === "number" ? payload.move_min_px : 60,
				moveMaxPx: typeof payload.move_max_px === "number" ? payload.move_max_px : 240,
				moveStrideDefault: typeof payload.move_stride_default_px === "number" ? payload.move_stride_default_px : 120,
				chain: payload.chain && typeof payload.chain === "object" ? payload.chain : null,
				moveStrides: payload.move_strides && typeof payload.move_strides === "object" ? payload.move_strides : {}
			};
		}

		/** Placement of the opaque body inside the frame, in fractions of the frame. */
		function bodyRectFractions(description) {
			var canvas = description.canvas;
			var box = description.bodyBox;
			if (!Array.isArray(canvas) || !Array.isArray(box) || canvas.length < 2 || box.length < 4) {
				return { left: 0, top: 0, width: 1, height: 1 };
			}
			var width = canvas[0] || 1;
			var height = canvas[1] || 1;
			return {
				left: clamp(box[0] / width, 0, 1),
				top: clamp(box[1] / height, 0, 1),
				width: clamp((box[2] - box[0]) / width, 0, 1),
				height: clamp((box[3] - box[1]) / height, 0, 1)
			};
		}

		/**
		 * Which layer may paint the character right now.
		 *
		 * Exactly one may. The still frame is the resting pose and the decoder shows
		 * the live pose, so painting both composites two different poses into one
		 * silhouette — the double image ("重影") users see while an action plays.
		 * While a decoder is up it takes over, and it carries the same inline still
		 * frame as its own `poster`, so the hand-over swaps identical pixels and no
		 * blank frame is ever shown.
		 */
		function mediaLayers(playing, posterSrc) {
			var hasPoster = typeof posterSrc === "string" && posterSrc.length > 0;
			return {
				poster: hasPoster,
				posterVisible: hasPoster && !playing,
				video: playing || !hasPoster,
				videoPoster: hasPoster ? posterSrc : null
			};
		}

		function assetBase() {
			var injected = window.__DSH_PET__;
			if (injected !== null && typeof injected === "object" && typeof injected.base === "string") {
				return injected.base.replace(/\/+$/, "");
			}
			return FALLBACK_BASE;
		}

		function loadLocalSettings() {
			try {
				return readSettings(window.localStorage.getItem(STORAGE_KEY));
			} catch (error) {
				return readSettings(null);
			}
		}

		function saveLocalSettings(settings) {
			try {
				window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
			} catch (error) {
				/* private mode or a full quota: settings simply do not persist */
			}
		}

		/**
		 * Keep the bottom-right corner fixed when the pet changes size.
		 *
		 * Growing from the top-left corner at the bottom-right of the screen pushes
		 * most of the pet off-screen, which reads as "the size slider does nothing".
		 */
		function anchorAfterResize(previous, next, pos, viewport) {
			if (pos === null || previous.width === 0) return pos;
			var dx = next.width - previous.width;
			var dy = next.height - previous.height;
			if (dx === 0 && dy === 0) return pos;
			return {
				x: clamp(pos.x - dx, 0, Math.max(0, viewport.width - next.width)),
				y: clamp(pos.y - dy, 0, Math.max(0, viewport.height - next.height))
			};
		}

		/**
		 * Coalesce rapid samples onto the frame clock. `commit` is called at most once
		 * per frame and reads the latest value itself.
		 */
		function createFrameCoalescer(requestFrame, commit) {
			var pending = 0;
			return function () {
				if (pending) return;
				pending = requestFrame(function () {
					pending = 0;
					commit();
				});
			};
		}

		/**
		 * Trailing-debounced writer: many schedule() calls produce one save(), and
		 * flush() guarantees the last value still lands on teardown.
		 */
		function createDebouncedSaver(setTimer, clearTimer, save, delay) {
			var handle = 0;
			return {
				schedule: function () {
					if (handle) clearTimer(handle);
					handle = setTimer(function () {
						handle = 0;
						save();
					}, delay);
				},
				flush: function () {
					if (!handle) return;
					clearTimer(handle);
					handle = 0;
					save();
				}
			};
		}

		// ---------------------------------------------------------------- engine

		function Pet() {
			let [description, setDescription] = React.useState(null);
			let [failure, setFailure] = React.useState(null);
			let [attempt, setAttempt] = React.useState(0);
			let [settings, setSettings] = React.useState(loadLocalSettings);
			let [showSettings, setShowSettings] = React.useState(false);
			let [bubble, setBubble] = React.useState(null);
			let [clip, setClip] = React.useState(null);
			// Whether the <video> is mounted at all. Between interactions it is not,
			// so no decoder exists and the pet costs nothing.
			let [playing, setPlaying] = React.useState(false);
			let [pos, setPos] = React.useState({ x: null, y: null });
			let [motion, setMotion] = React.useState(null);
			// Easter-egg presentation state. Kept separate from the animation machine
			// because it is pure decoration: it never changes which clip plays.
			let [spin, setSpin] = React.useState({ deg: 0, ms: 0 });
			let [probeDismissed, setProbeDismissed] = React.useState(false);

			let videoRef = React.useRef(null);
			let stageRef = React.useRef(null);
			// Last size we re-anchored from, plus the two rate limiters.
			let lastSize = React.useRef({ width: 0, height: 0 });
			let saverRef = React.useRef(null);
			let posPushRef = React.useRef(null);
			if (saverRef.current === null) {
				saverRef.current = createDebouncedSaver(
					function (fn, delay) {
						return window.setTimeout(fn, delay);
					},
					function (handle) {
						window.clearTimeout(handle);
					},
					function () {
						saveLocalSettings(machine.current.settings);
					},
					SAVE_DEBOUNCE_MS
				);
			}
			if (posPushRef.current === null) {
				posPushRef.current = createFrameCoalescer(
					function (fn) {
						return window.requestAnimationFrame(fn);
					},
					function () {
						setPos(machine.current.pos);
					}
				);
			}
			let machine = React.useRef({
				busy: false,
				timer: null,
				nextChainAt: 0,
				selfTalkAt: 0,
				drag: null,
				motion: null,
				pos: null,
				settings: settings,
				description: null,
				lastTick: 0,
				raf: 0
			});
			let tickRef = React.useRef(function () {});
			// Latest playback-failure fallback, for handlers registered once (the
			// visibility listener) that must not re-register on every render.
			let failRef = React.useRef(function () {});

			// Expose a small read-only view for manual inspection. Registered from an
			// effect so rendering stays free of global side effects.
			React.useEffect(function () {
				window[DEBUG_KEY] = {
					version: "0.2.0",
					state: function () {
						var self = machine.current;
						return {
							clip: self.state ? self.state.clip : null,
							mode: self.state ? self.state.mode : null,
							busy: self.busy,
							settings: self.settings,
							position: self.pos,
							hidden: document.hidden
						};
					},
					failure: function () {
						return failure;
					},
					description: function () {
						return machine.current.description;
					}
				};
				return function () {
					try {
						delete window[DEBUG_KEY];
					} catch (error) {
						window[DEBUG_KEY] = undefined;
					}
				};
			}, [failure]);

			React.useEffect(function () {
				machine.current.settings = settings;
			}, [settings]);

			/** Merge a patch into settings without depending on a possibly stale render. */
			var updateSettings = React.useCallback(function (patch) {
				setSettings(function (previous) {
					return Object.assign({}, previous, patch);
				});
			}, []);

			// ---- settings persistence -------------------------------------
			// Debounced: a slider drag emits dozens of changes per second, and writing
			// localStorage synchronously on each one is what made the panel stutter.
			React.useEffect(function () {
				saverRef.current.schedule();
			}, [settings]);

			// The pending write must survive teardown, or the last drag is lost.
			React.useEffect(function () {
				return function () {
					if (saverRef.current !== null) saverRef.current.flush();
				};
			}, []);

			// ---- load the clip description (retryable) --------------------
			React.useEffect(function () {
				var cancelled = false;
				var base = assetBase();
				// The two facts that split the failure space in half are the base in
				// use and whether the host half managed to inject it. Reporting both
				// on screen means a routing failure is diagnosable without DevTools.
				var injected = typeof window.__DSH_PET__ === "object" && window.__DSH_PET__ !== null;
				var where = "base=" + base + " 宿主注入=" + (injected ? "有" : "无");
				fetch(base + "/clips.json", { cache: "no-store" })
					.then(function (response) {
						if (!response.ok) throw new Error("clips.json " + response.status + "（" + where + "）");
						return response.json();
					})
					.then(function (payload) {
						if (cancelled) return;
						var parsed = parseClips(payload);
						if (parsed === null) throw new Error("clips.json 结构不合法（" + where + "）");
						machine.current.description = parsed;
						setFailure(null);
						setDescription(parsed);
					})
					.catch(function (error) {
						if (cancelled) return;
						setFailure(String((error && error.message) || error));
					});
				return function () {
					cancelled = true;
				};
			}, [attempt]);

			// ---- one scheduler for everything ----------------------------
			React.useEffect(function () {
				if (description === null) return;
				var dead = false;
				var id = window.setInterval(function () {
					if (dead || document.hidden) return;
					tickRef.current();
				}, 250);
				return function () {
					dead = true;
					window.clearInterval(id);
				};
			}, [description]);

			// ---- visibility: the single biggest saving -------------------
			React.useEffect(function () {
				var onVisibility = function () {
					var video = videoRef.current;
					if (video === null) return;
					if (document.hidden) {
						video.pause();
					} else if (!machine.current.busy) {
						var attempt = video.play();
						if (attempt && typeof attempt.catch === "function") {
							attempt.catch(function (error) {
								failRef.current(error);
							});
						}
					}
				};
				document.addEventListener("visibilitychange", onVisibility);
				return function () {
					document.removeEventListener("visibilitychange", onVisibility);
				};
			}, []);

			// ---- movement loop: rAF only while actually walking ----------
			React.useEffect(function () {
				if (motion === null) return;
				var frame = 0;
				var step = function (timestamp) {
					if (document.hidden) {
						frame = window.requestAnimationFrame(step);
						return;
					}
					var self = machine.current;
					if (self.motion === null) return;
					var elapsed = timestamp - self.motion.startedAt;
					var progress = self.motion.duration <= 0 ? 1 : clamp(elapsed / self.motion.duration, 0, 1);
					var x = self.motion.fromX + (self.motion.toX - self.motion.fromX) * progress;
					var next = { x: x, y: self.motion.y };
					self.pos = next;
					setPos(next);
					if (progress >= 1) {
						self.motion = null;
						self.busy = false;
						setMotion(null);
						self.nextChainAt = 0;
						// A walk that finished must not leave the decoder running:
						// the tick below puts the still frame back.
						self.returnToIdle = true;
						return;
					}
					frame = window.requestAnimationFrame(step);
				};
				frame = window.requestAnimationFrame(step);
				return function () {
					window.cancelAnimationFrame(frame);
				};
			}, [motion]);

			// ---- placement -------------------------------------------------
			var stage = React.useMemo(function () {
				if (description === null) return null;
				var canvas = description.canvas;
				return {
					width: Math.round(canvas[0] * FIXED_SCALE),
					height: Math.round(canvas[1] * FIXED_SCALE),
					body: bodyRectFractions(description),
					margin: description.cornerMargin
				};
			}, [description]);

			React.useEffect(function () {
				if (stage === null) return;
				var self = machine.current;
				if (self.pos === null) {
					self.pos = {
						x: Math.max(stage.margin, window.innerWidth - stage.width - stage.margin),
						y: Math.max(stage.margin, window.innerHeight - stage.height - stage.margin)
					};
					setPos(self.pos);
				}
				var onResize = function () {
					if (machine.current.pos === null) return;
					var clamped = {
						x: clamp(machine.current.pos.x, 0, Math.max(0, window.innerWidth - stage.width)),
						y: clamp(machine.current.pos.y, 0, Math.max(0, window.innerHeight - stage.height))
					};
					machine.current.pos = clamped;
					setPos(clamped);
				};
				window.addEventListener("resize", onResize);
				return function () {
					window.removeEventListener("resize", onResize);
				};
			}, [stage]);

			// ---- keep the pet anchored when its size changes ----------------
			// Growing from the top-left corner at the bottom-right of the screen pushes
			// most of the pet off-screen, which reads as "the size slider does
			// nothing". Anchor the bottom-right corner instead and let it grow inward.
			React.useEffect(function () {
				if (stage === null) return;
				var self = machine.current;
				var previous = lastSize.current;
				lastSize.current = { width: stage.width, height: stage.height };
				if (self.pos === null) return;
				var next = anchorAfterResize(previous, stage, self.pos, {
					width: window.innerWidth,
					height: window.innerHeight
				});
				if (next === self.pos) return;
				self.pos = next;
				setPos(next);
			}, [stage]);

			// ---- coalesce position updates onto the frame clock --------------
			// A pointer can report far more often than the display refreshes; committing
			// every sample would re-render the tree several times per frame.
			var commitPos = React.useCallback(function (next) {
				// The drag maths reads machine.current.pos synchronously, so the value is
				// authoritative immediately; only the render commit is deferred.
				machine.current.pos = next;
				posPushRef.current();
			}, []);

			// ---- the animation chain --------------------------------------
			/**
			 * Show a clip. `animate: false` keeps the poster up and decodes
			 * nothing — the idle state must not cost a software VP9 alpha decode,
			 * which measured 34% of one core while looping.
			 */
			var play = React.useCallback(function (nextClip, options) {
				var self = machine.current;
				var opts = options || {};
				self.state = { clip: nextClip.id, mode: opts.mode || nextClip.category };
				if (opts.animate === false) self.busy = false;
				else if (opts.busy === true) self.busy = true;
				setClip(nextClip);
				setPlaying(opts.animate !== false);
			}, []);

			var pickFrom = React.useCallback(function (category) {
				if (description === null) return null;
				var list = description.byCategory[category] || [];
				return pickOne(list.length > 0 ? list : description.byCategory.idle);
			}, [description]);

			var scheduleSelfTalk = React.useCallback(function (at) {
				var self = machine.current;
				var settingsNow = self.settings;
				self.selfTalkAt = settingsNow.selfTalk ? at + randomBetween(settingsNow.selfTalkMinMs, settingsNow.selfTalkMaxMs) : 0;
			}, []);

			var say = React.useCallback(function (text, holdMs) {
				var settingsNow = machine.current.settings;
				if (!settingsNow.bubbles) return;
				var value = text || pickOne(FALLBACK_PHRASES);
				setBubble({ text: value, until: Date.now() + (holdMs || bubbleDurationMs(value)) });
			}, []);

			var advanceChain = React.useCallback(function (timestamp) {
				var self = machine.current;
				if (description === null || self.busy) return;
				var category = pickCategory(Math.random(), description.chain);
				if (category === "move") {
					var target = pickFrom("move");
					if (target !== null && stage !== null && self.pos !== null) {
						var margin = stage.margin;
						var maxX = Math.max(margin, window.innerWidth - stage.width - margin);
						var direction = Math.random() < 0.5 ? -1 : 1;
						var rawDistance = randomBetween(description.moveMinPx, description.moveMaxPx) * direction;
						var stride = description.moveStrides[target.id] || description.moveStrideDefault;
						var distance = quantizeMove(rawDistance, stride);
						var toX = clamp(self.pos.x + distance, margin, maxX);
						var duration = Math.abs(toX - self.pos.x) / 90 * 1000;
						if (duration < 250) {
							category = "idle";
						} else {
							self.motion = {
								fromX: self.pos.x,
								toX: toX,
								y: self.pos.y,
								startedAt: timestamp,
								duration: duration
							};
							self.busy = true;
							setMotion(self.motion);
							play(target, { mode: "move", busy: true });
							return;
						}
					}
				}
				var chosen = pickFrom(category === "act" ? "random" : category) || pickFrom("idle");
				if (chosen === null) return;
				var idleAnimationOn = self.settings.idleAnimation === "always";
				if (category === "idle") {
					// Poster-only idle: nothing is decoded, so the pet can sit there
					// all day for free. Re-picking is rare because nothing is lost.
					play(chosen, { mode: "idle", animate: idleAnimationOn });
					self.busy = false;
					self.nextChainAt =
						timestamp + (idleAnimationOn ? randomBetween(2600, 6200) : randomBetween(8000, 20000));
					return;
				}
				play(chosen, { mode: category, busy: true });
				self.busy = true;
				self.nextChainAt = timestamp + randomBetween(2600, 6200);
			}, [description, pickFrom, play, stage]);

			var tick = React.useCallback(function () {
				var self = machine.current;
				var timestamp = Date.now();
				if (self.returnToIdle) {
					self.returnToIdle = false;
					var back = pickFrom("idle");
					if (back !== null) play(back, { mode: "idle", animate: false });
				}
				if (bubble !== null && timestamp >= bubble.until) setBubble(null);
				if (settings.selfTalk && self.selfTalkAt > 0 && timestamp >= self.selfTalkAt) {
					say(null);
					scheduleSelfTalk(timestamp);
				}
				if (!self.busy && self.motion === null && (self.nextChainAt === 0 || timestamp >= self.nextChainAt)) {
					advanceChain(timestamp);
				}
			}, [advanceChain, bubble, pickFrom, play, say, scheduleSelfTalk, settings.selfTalk]);

			tickRef.current = tick;

			// ---- playback failure paths -----------------------------------
			/**
			 * Back to the resting still frame. Shared by a finished clip and every
			 * failure path: the still frame must not paint under a running decoder, so
			 * a decoder that never delivers a frame would leave an empty corner
			 * instead of a pet unless each failure lands here.
			 */
			var settleToIdle = React.useCallback(function () {
				var self = machine.current;
				self.busy = false;
				setPlaying(false);
				var idle = pickFrom("idle");
				if (idle !== null) play(idle, { mode: "idle", animate: false });
				self.nextChainAt = 0;
			}, [pickFrom, play]);

			/** A rejected play() must not strand the pet behind a decoder that never paints. */
			var onPlayRejected = React.useCallback(function (error) {
				// A newer load() aborts the previous play() promise; that is normal churn.
				if (error && error.name === "AbortError") return;
				settleToIdle();
			}, [settleToIdle]);
			failRef.current = onPlayRejected;

			var onVideoError = React.useCallback(function () {
				// With no inlined still frame there is nothing to fall back to, so say
				// what happened instead of leaving a silent empty corner.
				if (description !== null && typeof description.idlePoster === "string") {
					settleToIdle();
					return;
				}
				setFailure("动画解码失败（clips.json 里没有可回退的内联静态帧）");
			}, [description, settleToIdle]);

			// ---- clip playback --------------------------------------------
			// The render below creates the element with its source and poster already
			// set, so there is nothing to load here — this only starts it. When
			// `playing` flips false the element is unmounted, which drops the decoder
			// immediately.
			React.useEffect(function () {
				var video = videoRef.current;
				if (video === null || clip === null || !playing) return;
				var attempt = video.play();
				if (attempt && typeof attempt.catch === "function") attempt.catch(onPlayRejected);
			}, [clip, playing, onPlayRejected]);

			var onEnded = settleToIdle;

			// ---- pointer interaction --------------------------------------
			var onPointerDown = React.useCallback(function (event) {
				if (event.button !== 0) return;
				var self = machine.current;
				// Remember tap times so a burst of taps can escalate into a spin.
				self.clickTimes = (self.clickTimes || []).filter(function (at) {
					return Date.now() - at < 2000;
				});
				self.clickTimes.push(Date.now());
				event.currentTarget.setPointerCapture(event.pointerId);
				self.drag = {
					pointerId: event.pointerId,
					startX: event.clientX,
					startY: event.clientY,
					originX: self.pos ? self.pos.x : 0,
					originY: self.pos ? self.pos.y : 0,
					moved: false,
					lastAt: Date.now(),
					lastX: event.clientX,
					velocity: 0
				};
			}, []);

			var onPointerMove = React.useCallback(function (event) {
				var self = machine.current;
				if (self.drag === null || self.drag.pointerId !== event.pointerId) return;
				var dx = event.clientX - self.drag.startX;
				var dy = event.clientY - self.drag.startY;
				if (!self.drag.moved && Math.abs(dx) + Math.abs(dy) < description.dragThreshold) return;
				if (!self.drag.moved) {
					self.drag.moved = true;
					self.motion = null;
					setMotion(null);
					var dragClip = pickFrom("drag");
					if (dragClip !== null) play(dragClip, { mode: "drag", busy: true });
				}
				var next = {
					x: clamp(self.drag.originX + dx, 0, Math.max(0, window.innerWidth - stage.width)),
					y: clamp(self.drag.originY + dy, 0, Math.max(0, window.innerHeight - stage.height))
				};
				var nowAt = Date.now();
				var elapsed = Math.max(1, nowAt - self.drag.lastAt);
				self.drag.velocity = (event.clientX - self.drag.lastX) / elapsed;
				self.drag.lastAt = nowAt;
				self.drag.lastX = event.clientX;
				commitPos(next);
				// Dragging away from the edge retires the edge-peek pose.
				var margin = stage === null ? 24 : stage.margin;
				var farX = stage === null ? window.innerWidth : Math.max(margin, window.innerWidth - stage.width - margin);
				if (next.x > margin + 1 && next.x < farX - 1) setProbeDismissed(false);
			}, [commitPos, description, pickFrom, play, stage]);

			/** Start (or speed up) a golden-spin turn. Returns the new duration. */
			var startSpin = React.useCallback(function () {
				var self = machine.current;
				var nextMs = self.spinMs > 0 ? Math.max(200, self.spinMs * 0.82) : 700;
				self.spinMs = nextMs;
				self.spinDeg = (self.spinDeg || 0) + 360;
				setSpin({ deg: self.spinDeg, ms: nextMs });
				return nextMs;
			}, []);

			var onPointerUp = React.useCallback(function (event) {
				var self = machine.current;
				if (self.drag === null || self.drag.pointerId !== event.pointerId) return;
				var drag = self.drag;
				self.drag = null;
				if (!drag.moved) {
					// Three quick taps escalate into a golden spin, each turn faster.
					var stamp = Date.now();
					var recent = (self.clickTimes || []).filter(function (at) {
						return stamp - at < 800;
					});
					if (recent.length >= 3) startSpin();
					setProbeDismissed(true);
					var clickClip = pickFrom("click") || pickFrom("idle");
					if (clickClip !== null) play(clickClip, { mode: "click", busy: true });
					say(null);
					return;
				}
				// A throw: coast a short distance in the direction of travel, then settle.
				var coast = clamp(drag.velocity * 260, -320, 320);
				if (Math.abs(coast) >= 20 && stage !== null && self.pos !== null) {
					var margin = stage.margin;
					var farX = Math.max(margin, window.innerWidth - stage.width - margin);
					var raw = self.pos.x + coast;
					var toX = clamp(raw, margin, farX);
					// Hitting a wall at speed knocks the pet spinning, the browser-side
					// equivalent of the desktop build's knock-away easter egg.
					if (Math.abs(raw - toX) > 1) startSpin();
					if (Math.abs(toX - self.pos.x) >= 8) {
						var air = pickFrom("drag") || pickFrom("idle");
						if (air !== null) play(air, { mode: "drag", busy: true });
						self.motion = {
							fromX: self.pos.x,
							toX: toX,
							y: self.pos.y,
							startedAt: Date.now(),
							duration: clamp(Math.abs(toX - self.pos.x) * 3.2, 220, 900)
						};
						self.busy = true;
						setMotion(self.motion);
						return;
					}
				}
				var idle = pickFrom("idle");
				if (idle !== null) play(idle, { mode: "idle" });
				self.busy = false;
				self.nextChainAt = 0;
			}, [pickFrom, play, say, stage, startSpin]);

			React.useEffect(function () {
				if (description === null) return;
				var self = machine.current;
				self.busy = false;
				self.nextChainAt = 0;
				// Start on the still frame: a freshly loaded page must not open a
				// decoder before the user has interacted.
				var first = pickFrom("idle");
				if (first !== null) play(first, { mode: "idle", animate: false });
				scheduleSelfTalk(Date.now());
			}, [description, pickFrom, play, scheduleSelfTalk]);

			// ---- render ----------------------------------------------------
			if (failure !== null) {
				return React.createElement(
					"div",
					{ style: { position: "fixed", right: "16px", bottom: "16px", pointerEvents: "auto", font: "11px/1.4 ui-monospace, monospace", color: "#e8e8ea", background: "rgba(150,20,20,.85)", padding: "6px 8px", borderRadius: "8px", maxWidth: "300px" } },
					React.createElement("div", null, "大肥鱼加载失败：" + failure),
					React.createElement(
						"button",
						{
							type: "button",
							style: { marginTop: "4px", font: "inherit", cursor: "pointer" },
							onClick: function () {
								setFailure(null);
								setAttempt(attempt + 1);
							}
						},
						"重试"
					)
				);
			}
			// Hidden on purpose. This must still render a way back: the preference is
			// persisted, so returning null here would strand the user with a pet they
			// can never summon again — the settings panel lives inside the very tree
			// that just disappeared. It is checked before the clips load so the way
			// back never depends on the asset route being healthy.
			if (!settings.enabled) {
				return React.createElement(
					"div",
					{
						"data-dsh-pet-restore": "1",
						title: "显示大肥鱼",
						onClick: function () {
							updateSettings({ enabled: true });
						},
						style: {
							position: "fixed",
							right: 0,
							bottom: 0,
							width: "30px",
							height: "30px",
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							borderRadius: "10px 0 0 0",
							background: "rgba(24,24,28,.5)",
							color: "#e8e8ea",
							font: "14px/1 system-ui, sans-serif",
							cursor: "pointer",
							userSelect: "none",
							pointerEvents: "auto",
							zIndex: 1,
							opacity: 0.75
						}
					},
					"🐟"
				);
			}
			if (description === null || stage === null || pos.x === null) return null;

			var scaleFactor = clamp(Number(settings.bubbleTextScale) / 100, 0.5, 3);
			var bodyLeft = stage.width * stage.body.left;
			var bodyTop = stage.height * stage.body.top;
			var bodyWidth = Math.max(24, stage.width * stage.body.width);
			var bodyHeight = Math.max(24, stage.height * stage.body.height);

			// Edge-peek: parked against a viewport edge, the pet leans out of it.
			var farX = Math.max(stage.margin, window.innerWidth - stage.width - stage.margin);
			var atEdge = pos.x <= stage.margin + 1 ? "left" : pos.x >= farX - 1 ? "right" : null;
			var probe = atEdge !== null && !probeDismissed ? atEdge : null;

			// One geometry for whatever is on screen, so swapping the still frame for
			// the decoder never shifts the pet.
			var mediaStyle = {
				position: "absolute",
				left: 0,
				top: 0,
				width: stage.width,
				height: stage.height,
				background: "transparent",
				display: "block",
				pointerEvents: "none",
				// No border of any kind: a failed frame must never leave a box outline
				// behind (Chrome draws one around a broken <img>).
				border: "none",
				outline: "none",
				transform: spin.deg === 0 ? "none" : "rotate(" + spin.deg + "deg)",
				transition: spin.ms > 0 ? "transform " + spin.ms + "ms linear" : "none",
				transformOrigin: "50% 60%"
			};

			var children = [];
			// One inlined still frame, always mounted. It is what shows between
			// animations, and because it is a data URL it can neither 404 nor be
			// painted as a bordered broken-image placeholder.
			var posterSrc = description.idlePoster;
			var layers = mediaLayers(playing, posterSrc);
			// Hiding is a state, not a DOM mutation: the node stays mounted so its
			// decoded bitmap stays warm, and the value flips back with `playing`.
			// (An imperative one-way `visibility:hidden` on a reused node was a
			// previous defect — it never came back.)
			var posterHiddenStyle = Object.assign({}, mediaStyle, { opacity: 0 });
			if (layers.poster) {
				children.push(
					React.createElement("img", {
						key: "poster",
						src: posterSrc,
						alt: "",
						draggable: false,
						style: layers.posterVisible ? mediaStyle : posterHiddenStyle
					})
				);
			}
			// The decoder exists only while something is actually playing — or when no
			// still frame could be resolved at all, in which case a decoder is still
			// better than an empty corner. A fresh element per clip is deliberate: a
			// reused one keeps painting the previous clip's last frame while the next
			// resource loads, which is the other half of a double image.
			if (layers.video && clip !== null) {
				children.push(
					React.createElement("video", {
						key: "video:" + clip.id,
						ref: videoRef,
						src: assetBase() + "/" + clip.file,
						// The same inline still frame the <img> shows, so swapping the
						// still frame for the decoder hands over identical pixels.
						poster: layers.videoPoster || undefined,
						loop: clip.category === "idle" || clip.category === "move" || clip.category === "turn",
						style: mediaStyle,
						onEnded: onEnded,
						onError: onVideoError,
						muted: true,
						playsInline: true
					})
				);
			}
			children.push(
				React.createElement("div", {
					key: "hit",
					onPointerDown: onPointerDown,
					onPointerMove: onPointerMove,
					onPointerUp: onPointerUp,
					// Dropping a file plays a reaction and touches nothing else: the
					// payload is never read, stored or forwarded.
					onDragOver: function (event) {
						event.preventDefault();
					},
					onDrop: function (event) {
						event.preventDefault();
						event.stopPropagation();
						var snack = pickFrom("random") || pickFrom("click") || pickFrom("idle");
						if (snack !== null) play(snack, { mode: "act", busy: true });
						say("这个我不能吃，但看起来不错～");
					},
					onContextMenu: function (event) {
						event.preventDefault();
						setShowSettings(function (value) {
							return !value;
						});
					},
					style: {
						position: "absolute",
						left: bodyLeft,
						top: bodyTop,
						width: bodyWidth,
						height: bodyHeight,
						pointerEvents: "auto",
						cursor: "grab",
						borderRadius: "8px"
					}
				})
			);

			if (bubble !== null) {
				children.push(
					React.createElement(
						"div",
						{
							key: "bubble",
							style: {
								position: "absolute",
								right: 0,
								bottom: stage.height + 6,
								maxWidth: Math.round(200 * scaleFactor),
								background: "rgba(255,255,255,.96)",
								color: "#1c1c1e",
								borderRadius: "10px",
								padding: "6px 9px",
								fontSize: Math.round(12 * scaleFactor),
								lineHeight: 1.35,
								boxShadow: "0 4px 14px rgba(0,0,0,.25)",
								pointerEvents: "none",
								whiteSpace: "pre-wrap"
							}
						},
						bubble.text
					)
				);
			}

			var settingsPanel = null;
			if (showSettings) {
				var row = function (label, control) {
					return React.createElement(
						"label",
						{ key: label, style: { display: "flex", justifyContent: "space-between", gap: "8px", alignItems: "center", marginBottom: "4px" } },
						React.createElement("span", null, label),
						control
					);
				};
				// The panel is a *sibling* of the pet, positioned in viewport space.
				// Hanging it off the pet's box meant every size change slid the panel
				// (and the slider under the pointer) sideways mid-drag.
				var panelWidth = 200;
				var panelHeight = 250;
				var panelLeft = clamp(pos.x + stage.width / 2 - panelWidth / 2 - 5, 8, Math.max(8, window.innerWidth - panelWidth - 8));
				var panelAbove = pos.y - 8 - panelHeight >= 8;
				var panelTop = panelAbove
					? pos.y - 8 - panelHeight
					: clamp(pos.y + stage.height + 8, 8, Math.max(8, window.innerHeight - panelHeight - 8));
				settingsPanel = React.createElement(
						"div",
						{
							key: "settings",
							style: {
								position: "fixed",
								left: Math.round(panelLeft),
								top: Math.round(panelTop),
								background: "rgba(22,22,26,.96)",
								color: "#e8e8ea",
								border: "1px solid rgba(255,255,255,.16)",
								borderRadius: "10px",
								padding: "8px 10px",
								font: "11px/1.4 ui-monospace, monospace",
								width: panelWidth + "px",
								pointerEvents: "auto",
								zIndex: 2
							}
						},
						row(
							"显示桌宠",
							React.createElement("input", {
								type: "checkbox",
								checked: settings.enabled,
								onChange: function (event) {
									updateSettings({ enabled: event.target.checked });
								}
							})
						),
						row(
							"气泡",
							React.createElement("input", {
								type: "checkbox",
								checked: settings.bubbles,
								onChange: function (event) {
									updateSettings({ bubbles: event.target.checked });
								}
							})
						),
						row(
							"自言自语",
							React.createElement("input", {
								type: "checkbox",
								checked: settings.selfTalk,
								onChange: function (event) {
									updateSettings({ selfTalk: event.target.checked });
								}
							})
						),
						React.createElement("div", { style: { opacity: 0.7, margin: "6px 0 2px" } }, "待机动画 " + (settings.idleAnimation === "always" ? "常开" : "关闭")),
						React.createElement(
							"button",
							{
								type: "button",
								style: { font: "inherit", cursor: "pointer", width: "100%" },
								onClick: function () {
									updateSettings({
										idleAnimation: settings.idleAnimation === "always" ? "off" : "always"
									});
								}
							},
							settings.idleAnimation === "always" ? "改为静止待机（省 CPU）" : "开启待机动画（费 CPU）"
						),
						React.createElement("div", { style: { opacity: 0.7, margin: "6px 0 2px" } }, "气泡字号 " + Math.round(settings.bubbleTextScale) + "%"),
						React.createElement("input", {
							type: "range",
							min: "80",
							max: "200",
							value: String(Math.round(settings.bubbleTextScale)),
							style: { width: "100%" },
							onChange: function (event) {
								updateSettings({ bubbleTextScale: Number(event.target.value) });
							}
						})
				);
			}

			// Positioning is split in two on purpose:
			//   - the outer box carries only the translation, so moving the pet is a
			//     compositor transform rather than a layout pass on every frame;
			//   - the inner box carries the edge-peek rotation, so the two transforms
			//     cannot overwrite each other.
			var stageStyle = {
				position: "fixed",
				left: 0,
				top: 0,
				width: stage.width,
				height: stage.height,
				pointerEvents: "none",
				zIndex: 1,
				transform: "translate3d(" + Math.round(pos.x) + "px," + Math.round(pos.y) + "px,0)"
			};
			var innerStyle = {
				position: "absolute",
				left: 0,
				top: 0,
				width: "100%",
				height: "100%",
				transform:
					probe === "left"
						? "rotate(9deg) translateX(4px)"
						: probe === "right"
							? "rotate(-9deg) translateX(-4px)"
							: "none",
				transformOrigin: probe === "left" ? "left bottom" : "right bottom",
				transition: "transform 220ms ease"
			};

			return React.createElement(
				React.Fragment,
				null,
				React.createElement(
					"div",
					{ ref: stageRef, "data-dsh-pet-stage": "1", style: stageStyle },
					React.createElement("div", { "data-dsh-pet-inner": "1", style: innerStyle }, children)
				),
				settingsPanel
			);
		}

		// ---------------------------------------------------------------- plugin

		const inject = ["slots"];

		function apply(ctx) {
			// A failure here must cost the user their pet, never their GUI.
			try {
				var register = function () {
					return ctx.slots.inject("shell.overlay", function () {
						return ctx.slots.register(
							{
								name: "shell.overlay",
								id: "dsh-pet",
								order: 100
							},
							Pet
						);
					});
				};
				// Registered through ctx.effect so a plugin reload or dispose releases
				// the previous overlay instead of leaving a second pet mounted — two
				// pets with independent random chains is another way to see a double
				// image. Hosts without ctx.effect keep the plain registration.
				if (typeof ctx.effect === "function") ctx.effect(register, "dsh-pet: overlay");
				else register();
			} catch (error) {
				// eslint-disable-next-line no-console
				console.error("[dsh-pet] failed to register the overlay", error);
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		// Pure helpers, reachable from the Node test suite through the same loader
		// stub the shell uses. No runtime cost: this object is never touched by the
		// component above.
		exports.__test = {
			pickCategory: pickCategory,
			bubbleDurationMs: bubbleDurationMs,
			quantizeMove: quantizeMove,
			randomBetween: randomBetween,
			pickOne: pickOne,
			readSettings: readSettings,
			parseClips: parseClips,
			bodyRectFractions: bodyRectFractions,
			mediaLayers: mediaLayers,
			anchorAfterResize: anchorAfterResize,
			FIXED_SCALE: FIXED_SCALE,
			createFrameCoalescer: createFrameCoalescer,
			createDebouncedSaver: createDebouncedSaver,
			clamp: clamp
		};
		return module.exports;
	}
});
