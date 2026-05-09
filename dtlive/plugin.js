(function() {
    /**
     * @type {import('@skystream/sdk').Manifest}
     */
    // manifest is injected at runtime

    // ── API endpoints (relative to manifest.baseUrl) ───────────────────────────
    const API_PRIMARY   = manifest.baseUrl + "/jiotv2.json";
    const API_FALLBACK  = manifest.baseUrl + "/all_channels.json";

    const COMMON_HEADERS = {
        "Accept":        "application/json, text/plain, */*",
        "User-Agent":    "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.83 Mobile Safari/537.36",
        "Cache-Control": "no-cache, no-store"
    };

    let channelsCache = null;
    let channelsCacheTime = 0;
    const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

    // ── Helpers ─────────────────────────────────────────────────────────────────

    function clean(s) { return String(s || '').trim(); }

    function parseJsonSafe(s, fb) {
        try { return JSON.parse(s); } catch (_) { return fb; }
    }

    function hexToBase64Url(hex) {
        if (!hex) return null;
        try {
            var raw = '';
            for (var i = 0; i < hex.length; i += 2)
                raw += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
            return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        } catch (_) { return null; }
    }

    // ── Fetch channels from API ────────────────────────────────────────────────

    async function fetchChannels() {
        var now = Date.now();
        if (channelsCache && (now - channelsCacheTime) < CACHE_TTL) {
            return channelsCache;
        }

        var allChannels = [];

        // Try primary endpoint (jiotv2.json — 24 sports channels with working MPD URLs)
        try {
            var resp = await http_get(API_PRIMARY, COMMON_HEADERS);
            var data = parseJsonSafe(resp.body, null);

            if (Array.isArray(data) && data.length > 0) {
                var channels = data.map(function(ch) {
                    return {
                        id:     clean(ch.channel_id),
                        name:   clean(ch.channel_name),
                        logo:   clean(ch.channel_logo),
                        url:    clean(ch.channel_url),
                        genre:  clean(ch.channel_genre || ch.channel_category || 'Sports'),
                        keyId:  clean(ch.keyId),
                        key:    clean(ch.key),
                        cookie: clean(ch.cookie)
                    };
                }).filter(function(ch) { return ch.name && ch.url; });

                allChannels = allChannels.concat(channels);
            }
        } catch (_) {}

        // Fallback: all_channels.json (1195 channels across all genres)
        try {
            var resp2 = await http_get(API_FALLBACK, COMMON_HEADERS);
            var data2 = parseJsonSafe(resp2.body, null);

            if (Array.isArray(data2) && data2.length > 0) {
                var channels2 = data2.map(function(ch) {
                    var cookie = clean(ch.cookie || '');
                    var constructedUrl = clean(ch.channel_url);

                    // If no direct URL, construct from cookie ACL path
                    if (!constructedUrl && cookie) {
                        var aclMatch = cookie.match(/acl=([^~&]+)/);
                        if (aclMatch) {
                            var aclPath = aclMatch[1].replace(/\*$/, '').replace(/\/$/, '');
                            if (aclPath && aclPath !== '/') {
                                // Try both WDVLive and output paths
                                constructedUrl = 'https://jiotvpllive.cdn.jio.com' + aclPath + '/index.mpd';
                            }
                        }
                    }

                    return {
                        id:     clean(ch.channel_id),
                        name:   clean(ch.channel_name),
                        logo:   clean(ch.channel_logo),
                        url:    constructedUrl,
                        genre:  clean(ch.channel_genre || ch.channel_category || 'Uncategorized'),
                        keyId:  clean(ch.keyId),
                        key:    clean(ch.key),
                        cookie: cookie
                    };
                }).filter(function(ch) { return ch.name && ch.url; });

                // Deduplicate by channel ID (primary data takes precedence)
                var seenIds = {};
                allChannels.forEach(function(c) { seenIds[c.id] = true; });
                channels2.forEach(function(c) {
                    if (!seenIds[c.id]) {
                        allChannels.push(c);
                        seenIds[c.id] = true;
                    }
                });
            }
        } catch (_) {}

        if (allChannels.length > 0) {
            channelsCache = allChannels;
            channelsCacheTime = now;
        }

        return allChannels;
    }

    // Encode channel data into a URL string for passing between functions
    function encodeChannel(ch) {
        return JSON.stringify({ kind: 'channel', channel: ch });
    }

    // ── Genre display mapping ────────────────────────────────────────────────────
    function getGenreIcon(genre) {
        var g = (genre || '').toLowerCase();
        if (g.includes('sport')) return 'sports_soccer';
        if (g.includes('news')) return 'news';
        if (g.includes('movie')) return 'movie';
        if (g.includes('entertain') || g.includes('comedy')) return 'tv';
        if (g.includes('music')) return 'music_note';
        if (g.includes('kids') || g.includes('child')) return 'child_care';
        if (g.includes('devotion') || g.includes('religious') || g.includes('god')) return 'church';
        if (g.includes('infotain') || g.includes('lifestyle')) return 'lightbulb';
        if (g.includes('business')) return 'business';
        if (g.includes('education') || g.includes('learning')) return 'school';
        return 'live_tv';
    }

    // ── getHome ─────────────────────────────────────────────────────────────────

    async function getHome(cb) {
        try {
            var channels = await fetchChannels();
            if (channels.length === 0) {
                return cb({ success: false, errorCode: 'NOT_FOUND', message: 'No channels available' });
            }

            // Group channels by genre into sections
            var sections = {};
            channels.forEach(function(ch) {
                var genre = ch.genre || 'Uncategorized';
                if (!sections[genre]) sections[genre] = [];
                sections[genre].push(new MultimediaItem({
                    title:       ch.name,
                    url:         encodeChannel(ch),
                    posterUrl:   ch.logo || '',
                    type:        'livestream',
                    description: ch.genre || ''
                }));
            });

            // Build ordered sections
            var orderedSections = {};
            var genrePriority = ['Sports', 'News', 'Movies', 'Entertainment', 'Music', 'Kids', 'Devotional', 'Infotainment', 'Business', 'Education', 'Uncategorized'];

            // Add Trending section from most popular genre
            var keys = Object.keys(sections);
            if (keys.length > 0) {
                var firstGenre = keys[0];
                orderedSections['Trending'] = sections[firstGenre].slice(0, 15);
            }

            // Add all genre sections in priority order
            genrePriority.forEach(function(g) {
                if (sections[g] && g !== keys[0]) {
                    orderedSections[g] = sections[g];
                }
            });

            // Add remaining genres not in priority list
            keys.forEach(function(g) {
                if (!orderedSections[g]) {
                    orderedSections[g] = sections[g];
                }
            });

            cb({ success: true, data: orderedSections });
        } catch (e) {
            cb({ success: false, errorCode: 'HOME_ERROR', message: String(e && e.message || e) });
        }
    }

    // ── search ──────────────────────────────────────────────────────────────────

    async function search(query, cb) {
        try {
            var q = clean(query || '').toLowerCase();
            if (!q) return cb({ success: true, data: [] });

            var channels = await fetchChannels();
            var results = channels.filter(function(ch) {
                return ch.name.toLowerCase().includes(q) ||
                       (ch.genre || '').toLowerCase().includes(q);
            }).map(function(ch) {
                return new MultimediaItem({
                    title:       ch.name,
                    url:         encodeChannel(ch),
                    posterUrl:   ch.logo || '',
                    type:        'livestream',
                    description: ch.genre || ''
                });
            });

            cb({ success: true, data: results });
        } catch (_) {
            cb({ success: true, data: [] });
        }
    }

    // ── load ────────────────────────────────────────────────────────────────────

    async function load(url, cb) {
        try {
            var payload = parseJsonSafe(url, null);
            if (!payload || payload.kind !== 'channel') {
                return cb({ success: false, errorCode: 'PARSE_ERROR', message: 'Invalid payload' });
            }

            var ch = payload.channel;

            // Try to get fresh data for this channel
            var channels = await fetchChannels();
            var freshCh = channels.find(function(c) { return c.id === ch.id; }) || ch;

            cb({ success: true, data: new MultimediaItem({
                title:       freshCh.name,
                url:         encodeChannel(freshCh),
                posterUrl:   freshCh.logo || '',
                description: freshCh.genre || 'Live TV Channel',
                type:        'livestream',
                episodes: [new Episode({
                    name:       'Watch Live',
                    season:     1,
                    episode:    1,
                    url:        encodeChannel(freshCh),
                    posterUrl:  freshCh.logo || ''
                })]
            }) });
        } catch (e) {
            cb({ success: false, errorCode: 'LOAD_ERROR', message: String(e && e.message || e) });
        }
    }

    // ── loadStreams ─────────────────────────────────────────────────────────────

    async function loadStreams(url, cb) {
        try {
            var payload = parseJsonSafe(url, null);
            if (!payload || payload.kind !== 'channel') {
                return cb({ success: false, errorCode: 'PARSE_ERROR', message: 'Invalid stream payload' });
            }

            var ch = payload.channel;
            var streamUrl = clean(ch.url);
            if (!streamUrl) {
                return cb({ success: false, errorCode: 'NOT_FOUND', message: 'No stream URL available' });
            }

            // Build playback headers
            var headers = {
                "Referer":    "https://jiotv.catchup.cdn.jio.com/",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; rv:78.0) Gecko/20100101 Firefox/78.0",
                "Origin":     "https://jiotv.catchup.cdn.jio.com"
            };
            if (ch.cookie) {
                headers["Cookie"] = ch.cookie;
            }

            var stream = new StreamResult({
                url:     streamUrl,
                quality: 'auto',
                headers: headers
            });

            // Attach Clearkey DRM when available
            var keyId = clean(ch.keyId);
            var key   = clean(ch.key);
            if (keyId && key) {
                stream.drmKid = hexToBase64Url(keyId) || keyId;
                stream.drmKey = hexToBase64Url(key) || key;
            }

            cb({ success: true, data: [stream] });
        } catch (e) {
            cb({ success: false, errorCode: 'STREAM_ERROR', message: String(e && e.message || e) });
        }
    }

    // ── Export ───────────────────────────────────────────────────────────────────
    globalThis.getHome     = getHome;
    globalThis.search      = search;
    globalThis.load        = load;
    globalThis.loadStreams = loadStreams;

})();
