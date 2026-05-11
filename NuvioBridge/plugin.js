(function() {
    // =========================================================================
    // Nuvio Bridge v2 — SkyStream Plugin
    // Bridges 100+ Nuvio streaming providers into SkyStream.
    // Configure Nuvio manifest URLs in plugin.json → nuvioManifests array.
    // Uses TMDB for metadata (search, browse, episode listing).
    // =========================================================================

    // --- Constants ---
    var TAG = "NuvioBridge";
    var TMDB_KEY = "68e094699525b18a70bab2f86b1fa706";
    var TMDB_BASE = "https://api.themoviedb.org/3";
    var IMG_BASE = "https://image.tmdb.org/t/p";
    var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
    var HEADERS = { "User-Agent": UA, "Accept": "application/json" };

    // Fallback manifests if plugin.json doesn't provide them
    var FALLBACK_MANIFESTS = [
        "https://raw.githubusercontent.com/yoruix/nuvio-providers/refs/heads/main/manifest.json",
        "https://raw.githubusercontent.com/D3adlyRocket/All-in-One-Nuvio/refs/heads/main/manifest.json",
        "https://raw.githubusercontent.com/phisher98/phisher-nuvio-providers/refs/heads/main/manifest.json",
        "https://raw.githubusercontent.com/michat88/nuvio-providers/refs/heads/main/manifest.json",
        "https://raw.githubusercontent.com/PirateZoro9/nuvio-kabir-providers/refs/heads/main/manifest.json",
        "https://raw.githubusercontent.com/hihihihihiiray/plugins/refs/heads/main/manifest.json"
    ];

    // Timeouts (milliseconds)
    var FETCH_CODE_TIMEOUT = 10000;    // 10s to download provider code
    var PROVIDER_TIMEOUT = 15000;      // 15s for a provider's getStreams call

    // --- Caches ---
    var _providers = null;
    var _fnCache = {};

    // =========================================================================
    // HELPERS
    // =========================================================================

    function log(msg) { console.log("[" + TAG + "] " + msg); }

    // Promise timeout helper using setTimeout (available in the sandbox)
    function withTimeout(promise, ms, label) {
        return Promise.race([
            promise,
            new Promise(function(_, reject) {
                setTimeout(function() {
                    reject(new Error((label || "Operation") + " timed out after " + ms + "ms"));
                }, ms);
            })
        ]);
    }

    async function fetchJson(url, headers) {
        var h = Object.assign({}, HEADERS, headers || {});
        var res = await http_get(url, h);
        if (!res) throw new Error("Empty response (no response object)");
        if (res.status !== 200) throw new Error("HTTP " + res.status);
        var body = res.body;
        // http_get may return parsed JSON in body for JSON responses
        if (typeof body === "string") return JSON.parse(body);
        return body; // already parsed
    }

    async function fetchText(url, headers) {
        var h = Object.assign({}, HEADERS, headers || {});
        var res = await http_get(url, h);
        if (!res) throw new Error("Empty response");
        if (res.status !== 200) throw new Error("HTTP " + res.status);
        return res.body || "";
    }

    function tmdbUrl(path) {
        var sep = path.indexOf("?") >= 0 ? "&" : "?";
        return TMDB_BASE + path + sep + "api_key=" + TMDB_KEY;
    }

    async function tmdbFetch(path) {
        return fetchJson(tmdbUrl(path));
    }

    function imgUrl(path, size) {
        return path ? IMG_BASE + "/" + (size || "w500") + path : "";
    }

    // =========================================================================
    // URL SCHEME: JSON-encoded { tmdbId, type, season, episode }
    // =========================================================================

    function makeUrl(tmdbId, type, season, episode) {
        return JSON.stringify({ i: tmdbId, t: type, s: season || 0, e: episode || 0 });
    }

    function parseUrl(url) {
        try {
            var d = JSON.parse(url);
            return {
                tmdbId: d.i,
                mediaType: d.t,
                season: d.s > 0 ? d.s : null,
                episode: d.e > 0 ? d.e : null
            };
        } catch(e) { return null; }
    }

    // =========================================================================
    // FETCH POLYFILL (for Nuvio providers that use fetch() in SkyStream sandbox)
    // =========================================================================

    if (typeof globalThis.fetch === "undefined") {
        globalThis.fetch = function(url, opts) {
            return new Promise(function(resolve, reject) {
                var urlStr = (typeof url === "object" && url.url) ? url.url : String(url);
                var options = opts || {};
                var method = (options.method || "GET").toUpperCase();
                var reqHeaders = {};

                // Normalize headers (supports plain object or Headers-like with forEach)
                var h = options.headers || {};
                if (typeof h.forEach === "function") {
                    h.forEach(function(v, k) { reqHeaders[k] = v; });
                } else if (typeof h === "object") {
                    for (var k in h) {
                        if (Object.prototype.hasOwnProperty.call(h, k)) {
                            reqHeaders[k] = h[k];
                        }
                    }
                }

                function onResponse(resp) {
                    // Ensure bodyStr is always a string — http_get may return parsed JSON
                    var bodyStr = typeof resp.body === "string" ? resp.body :
                                  (resp.body ? JSON.stringify(resp.body) : "");
                    var ok = resp.status >= 200 && resp.status < 300;

                    resolve({
                        ok: ok,
                        status: resp.status,
                        statusText: resp.status === 200 ? "OK" : "Error",
                        headers: (resp.headers && typeof resp.headers === "object") ? {
                            get: function(name) {
                                if (!resp.headers) return null;
                                var val = resp.headers[name] || resp.headers[name.toLowerCase()] || null;
                                return Array.isArray(val) ? val[0] : val;
                            },
                            forEach: function(cb) {
                                if (!resp.headers) return;
                                for (var k in resp.headers) {
                                    if (Object.prototype.hasOwnProperty.call(resp.headers, k)) {
                                        cb(resp.headers[k], k);
                                    }
                                }
                            }
                        } : {
                            get: function() { return null; },
                            forEach: function() {}
                        },
                        url: urlStr,
                        redirected: false,
                        type: "basic",
                        json: function() { return Promise.resolve(JSON.parse(bodyStr)); },
                        text: function() { return Promise.resolve(bodyStr); },
                        blob: function() { return Promise.resolve(bodyStr); }
                    });
                }

                try {
                    if (method === "GET") {
                        http_get(urlStr, reqHeaders, onResponse);
                    } else if (method === "POST") {
                        http_post(urlStr, reqHeaders, options.body || "", onResponse);
                    } else {
                        // For HEAD, PUT, DELETE etc, use GET as fallback
                        http_get(urlStr, reqHeaders, onResponse);
                    }
                } catch(e) {
                    resolve({
                        ok: false, status: 0, statusText: e.message,
                        headers: { get: function() { return null; }, forEach: function() {} },
                        url: urlStr, redirected: false, type: "error",
                        json: function() { return Promise.reject(e); },
                        text: function() { return Promise.resolve(""); },
                        blob: function() { return Promise.resolve(""); }
                    });
                }
            });
        };
    }

    // Polyfill global/window for providers that reference them
    if (typeof global === "undefined") { globalThis.global = globalThis; }
    if (typeof window === "undefined") { globalThis.window = globalThis; }

    // =========================================================================
    // PROVIDER DISCOVERY
    // =========================================================================

    function getManifestUrls() {
        if (manifest && manifest.nuvioManifests && Array.isArray(manifest.nuvioManifests)) {
            return manifest.nuvioManifests;
        }
        return FALLBACK_MANIFESTS;
    }

    async function discoverProviders() {
        if (_providers) return _providers;

        var urls = getManifestUrls();
        log("Discovering Nuvio providers from " + urls.length + " manifests...");

        var all = [];

        await Promise.allSettled(urls.map(async function(manifestUrl) {
            try {
                var m = await fetchJson(manifestUrl);
                if (!m || !m.scrapers) return;

                var baseUrl = manifestUrl.substring(0, manifestUrl.lastIndexOf("/"));

                m.scrapers.forEach(function(s) {
                    if (s.enabled === false) return;
                    if (!s.filename) return;

                    var fileUrl = s.filename.indexOf("http") === 0 ? s.filename : baseUrl + "/" + s.filename;

                    all.push({
                        id: baseUrl + "/" + (s.id || s.name || s.filename),
                        name: s.name || s.id || s.filename,
                        fileUrl: fileUrl,
                        types: s.supportedTypes || ["movie", "tv"]
                    });
                });
            } catch(e) {
                log("Manifest error: " + manifestUrl.slice(0, 60) + "... - " + e.message);
            }
        }));

        log("Discovered " + all.length + " Nuvio providers");
        _providers = all;
        return all;
    }

    // =========================================================================
    // PROVIDER CODE LOADING & EXECUTION
    // =========================================================================

    async function loadProvider(id, fileUrl) {
        if (_fnCache[id]) return _fnCache[id];

        try {
            var code = await withTimeout(fetchText(fileUrl), FETCH_CODE_TIMEOUT, "Fetch " + fileUrl.split("/").pop());
            if (!code) throw new Error("Empty code");

            // Strip "use strict" to avoid sandbox issues
            code = code.replace(/^["']use strict["'];?\s*/m, "");

            // Execute with mock module.exports + return
            var factory = new Function("return (function(module){" + code + "\nreturn module.exports;})")();
            var mod = { exports: {} };
            var exported = factory(mod);

            if (exported && typeof exported.getStreams === "function") {
                _fnCache[id] = exported.getStreams;
                log("Loaded: " + fileUrl.split("/").pop());
                return exported.getStreams;
            }
        } catch(e) {
            log("Failed: " + fileUrl.split("/").pop() + " - " + e.message);
        }

        _fnCache[id] = null;
        return null;
    }

    async function callProvider(getStreamsFn, tmdbId, mediaType, season, episode, label) {
        try {
            var result = await withTimeout(
                getStreamsFn(tmdbId, mediaType, season, episode),
                PROVIDER_TIMEOUT,
                "Provider " + label
            );
            if (!Array.isArray(result)) return [];
            return result;
        } catch(e) {
            log(label + " error: " + e.message);
            return [];
        }
    }

    // =========================================================================
    // TMDB → MultimediaItem
    // =========================================================================

    function toItem(d, type) {
        var title = type === "tv" ? d.name : d.title;
        var date = type === "tv" ? d.first_air_date : d.release_date;
        var year = date ? parseInt(date.substring(0, 4), 10) : undefined;

        return new MultimediaItem({
            title: title || "Unknown",
            url: makeUrl(d.id, type),
            posterUrl: imgUrl(d.poster_path),
            type: type === "tv" ? "series" : "movie",
            year: year,
            score: d.vote_average || undefined,
            description: d.overview || "",
            bannerUrl: imgUrl(d.backdrop_path, "w1280"),
            cast: [],
            trailers: []
        });
    }

    // =========================================================================
    // PLUGIN FUNCTIONS
    // =========================================================================

    // ----- getHome -----
    async function getHome(cb) {
        try {
            var [movies, tv] = await Promise.all([
                tmdbFetch("/trending/movie/week"),
                tmdbFetch("/trending/tv/week")
            ]);

            var data = {};
            var allItems = [];

            if (movies && movies.results) {
                data["Trending Movies"] = movies.results.slice(0, 20).map(function(m) { return toItem(m, "movie"); });
                allItems = allItems.concat(data["Trending Movies"]);
            }
            if (tv && tv.results) {
                data["Trending TV Shows"] = tv.results.slice(0, 20).map(function(t) { return toItem(t, "tv"); });
                allItems = allItems.concat(data["Trending TV Shows"]);
            }
            if (allItems.length > 0) data["Trending"] = allItems.slice(0, 10);

            // Warm provider cache in background
            discoverProviders().catch(function(){});

            cb({ success: true, data: data });
        } catch(e) {
            log("getHome error: " + e.message);
            cb({ success: false, errorCode: "INTERNAL_ERROR", message: e.message });
        }
    }

    // ----- search -----
    async function search(query, cb) {
        try {
            var [movies, tv] = await Promise.all([
                tmdbFetch("/search/movie?query=" + encodeURIComponent(query)),
                tmdbFetch("/search/tv?query=" + encodeURIComponent(query))
            ]);

            var results = [];
            if (movies && movies.results) movies.results.slice(0, 10).forEach(function(m) { results.push(toItem(m, "movie")); });
            if (tv && tv.results) tv.results.slice(0, 10).forEach(function(t) { results.push(toItem(t, "tv")); });

            cb({ success: true, data: results });
        } catch(e) {
            log("search error: " + e.message);
            cb({ success: false, errorCode: "INTERNAL_ERROR", message: e.message });
        }
    }

    // ----- load -----
    async function load(url, cb) {
        try {
            var p = parseUrl(url);
            if (!p) return cb({ success: false, errorCode: "BAD_REQUEST", message: "Invalid URL" });

            if (p.mediaType === "movie") {
                var d = await tmdbFetch("/movie/" + p.tmdbId);
                if (!d) return cb({ success: false, errorCode: "NOT_FOUND" });
                cb({ success: true, data: toItem(d, "movie") });
            } else if (p.mediaType === "tv") {
                var [tvData, s1, s2, s3, s4, s5] = await Promise.all([
                    tmdbFetch("/tv/" + p.tmdbId),
                    tmdbFetch("/tv/" + p.tmdbId + "/season/1"),
                    tmdbFetch("/tv/" + p.tmdbId + "/season/2"),
                    tmdbFetch("/tv/" + p.tmdbId + "/season/3"),
                    tmdbFetch("/tv/" + p.tmdbId + "/season/4"),
                    tmdbFetch("/tv/" + p.tmdbId + "/season/5")
                ]);
                if (!tvData) return cb({ success: false, errorCode: "NOT_FOUND" });

                var item = toItem(tvData, "tv");
                var episodes = [];
                var seasons = [s1, s2, s3, s4, s5];

                seasons.forEach(function(sd) {
                    if (!sd || !sd.episodes) return;
                    sd.episodes.forEach(function(ep) {
                        episodes.push(new Episode({
                            name: "S" + String(sd.season_number).padStart(2, "0") + "E" + String(ep.episode_number).padStart(2, "0") + " - " + (ep.name || ""),
                            url: makeUrl(p.tmdbId, "tv", sd.season_number, ep.episode_number),
                            season: sd.season_number,
                            episode: ep.episode_number,
                            rating: ep.vote_average,
                            runtime: ep.runtime,
                            airDate: ep.air_date || ""
                        }));
                    });
                });

                item.episodes = episodes;
                log("load: " + episodes.length + " episodes");
                cb({ success: true, data: item });
            } else {
                cb({ success: false, errorCode: "BAD_REQUEST", message: "Unknown type: " + p.mediaType });
            }
        } catch(e) {
            log("load error: " + e.message);
            cb({ success: false, errorCode: "INTERNAL_ERROR", message: e.message });
        }
    }

    // ----- loadStreams -----
    async function loadStreams(url, cb) {
        try {
            var p = parseUrl(url);
            if (!p) return cb({ success: false, errorCode: "BAD_REQUEST" });

            log("Streams: TMDB " + p.tmdbId + " " + p.mediaType + (p.season ? " S" + p.season + "E" + p.episode : ""));

            var providers = await discoverProviders();
            if (!providers || providers.length === 0) return cb({ success: true, data: [] });

            // Filter providers supporting this media type
            var valid = providers.filter(function(pr) {
                var types = pr.types || ["movie", "tv"];
                return types.indexOf(p.mediaType) >= 0;
            });

            if (valid.length === 0) return cb({ success: true, data: [] });

            log("Trying " + valid.length + " providers...");

            var allStreams = [];
            var totalBatches = Math.ceil(valid.length / 5);

            // Process in batches of 5
            for (var i = 0; i < valid.length; i += 5) {
                var batch = valid.slice(i, i + 5);

                var batchResults = await Promise.allSettled(batch.map(async function(pr) {
                    var getStreamsFn = await loadProvider(pr.id, pr.fileUrl);
                    if (!getStreamsFn) return [];

                    var nStreams = await callProvider(
                        getStreamsFn, p.tmdbId, p.mediaType, p.season, p.episode, pr.name
                    );
                    if (!Array.isArray(nStreams)) return [];

                    return nStreams.map(function(s) {
                        if (!s || !s.url) return null;
                        return new StreamResult({
                            url: s.url,
                            quality: s.quality || "Auto",
                            headers: s.headers || {},
                            name: pr.name + (s.name ? " - " + s.name : "")
                        });
                    }).filter(function(s) { return s !== null; });
                }));

                batchResults.forEach(function(r) {
                    if (r.status === "fulfilled" && Array.isArray(r.value)) {
                        allStreams = allStreams.concat(r.value);
                    }
                });

                // Early exit: if we have enough streams, stop trying more providers
                if (allStreams.length >= 20) {
                    log("Early exit: found " + allStreams.length + " streams");
                    break;
                }
            }

            // Deduplicate by URL
            var seen = {};
            var unique = [];
            allStreams.forEach(function(s) {
                var key = s.url;
                if (!seen[key]) {
                    seen[key] = true;
                    unique.push(s);
                }
            });

            log("Found " + unique.length + " unique streams");
            cb({ success: true, data: unique });
        } catch(e) {
            log("loadStreams error: " + e.message);
            cb({ success: true, data: [] });
        }
    }

    // =========================================================================
    // EXPORTS
    // =========================================================================
    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;

    log("Plugin loaded");
})();
