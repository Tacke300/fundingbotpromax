import WebSocket from 'ws';
import http from 'http';
import https from 'https';
import express from 'express';
import { URL } from 'url';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { API_KEY, SECRET_KEY } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = 8888;

app.use(express.json());

const BINANCE_FAPI_BASE_URL = 'fapi.binance.com';
const BINANCE_WS_URL = 'wss://fstream.binance.com/stream?streams=';

const WINDOW_MINUTES = 10;
let coinData = {};
let topRankedCoinsForApi = [];
let allSymbols = [];
let wsClient = null;
let vps1DataStatus = "initializing";
let serverTimeOffset = 0;

let claimedCoins = {};
let botStatus = {};

function logVps1(message) {
    const now = new Date();
    const offset = 7 * 60 * 60 * 1000;
    const localTime = new Date(now.getTime() + offset);
    const timestamp = localTime.toISOString().replace('T', ' ').substring(0, 23);
    console.log(`[VPS1_DP] ${timestamp} - ${message}`);
}

function createSignature(queryString, apiSecret) {
    return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
}

async function makeHttpRequest(method, urlString, headers = {}, postData = '') {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(urlString);
        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: method,
            headers: { ...headers, 'User-Agent': 'NodeJS-Client/1.0-VPS1-DataProvider' },
            timeout: 20000
        };
        const protocol = parsedUrl.protocol === 'https:' ? https : http;
        const req = protocol.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                         if (res.headers['content-type'] && res.headers['content-type'].includes('application/json')) {
                           resolve(JSON.parse(data));
                        } else {
                           resolve(data);
                        }
                    } catch (e) {
                        const parseError = new Error(`HTTPS JSON Parse Error from ${urlString}: ${e.message}`);
                        parseError.data = data.substring(0, 300);
                        logVps1(parseError.message + `. Data: ${parseError.data}`);
                        reject(parseError);
                    }
                } else {
                    const error = new Error(`Request Failed. Status: ${res.statusCode} for ${urlString}.`);
                    error.statusCode = res.statusCode;
                    try {
                        error.body = JSON.parse(data);
                    } catch {
                        error.body = data.substring(0, 300);
                    }
                    logVps1(`HTTPS Error: ${error.message} Body: ${JSON.stringify(error.body)}`);
                    reject(error);
                }
            });
        });
        req.on('error', (error) => {
            logVps1(`HTTPS Network Error for ${urlString}: ${error.message}`);
            reject(error);
        });
        req.on('timeout', () => {
            req.destroy();
            const timeoutError = new Error(`Request to ${urlString} timed out`);
            logVps1(`HTTPS Timeout for ${urlString}`);
            reject(timeoutError);
        });
        if (postData) {
            req.write(postData);
        }
        req.end();
    });
}

async function callSignedAPI(fullEndpointPath, method = 'GET', params = {}) {
    if (!API_KEY || !SECRET_KEY) throw new Error("API_KEY/SECRET_KEY is missing in config.js");
    const timestamp = Date.now() + serverTimeOffset;
    const recvWindow = 5000;
    let queryString = Object.keys(params).map(key => `${key}=${encodeURIComponent(params[key])}`).join('&');
    queryString += (queryString ? '&' : '') + `timestamp=${timestamp}&recvWindow=${recvWindow}`;
    const signature = createSignature(queryString, SECRET_KEY);
    const fullUrlToCall = `https://${BINANCE_FAPI_BASE_URL}${fullEndpointPath}?${queryString}&signature=${signature}`;
    const headers = { 'X-MBX-APIKEY': API_KEY };

    try {
        return await makeHttpRequest(method, fullUrlToCall, headers);
    } catch (error) {
        logVps1(`[CRITICAL SIGNED API CALL FAILED] Endpoint: ${fullEndpointPath}`);
        logVps1(`  - Status Code: ${error.statusCode || 'N/A'}`);
        logVps1(`  - Binance Error Body: ${JSON.stringify(error.body) || 'N/A'}`);
        throw error;
    }
}

async function callPublicAPI(fullEndpointPath, params = {}) {
    const queryString = new URLSearchParams(params).toString();
    const fullPathWithQuery = `${fullEndpointPath}${queryString ? '?' + queryString : ''}`;
    const fullUrlToCall = `https://${BINANCE_FAPI_BASE_URL}${fullPathWithQuery}`;
    return makeHttpRequest('GET', fullUrlToCall);
}

async function syncServerTime() {
    try {
        const data = await callPublicAPI('/fapi/v1/time');
        serverTimeOffset = data.serverTime - Date.now();
        logVps1(`Server time synced. Offset: ${serverTimeOffset}ms.`);
    } catch (error) {
        logVps1(`Failed to sync server time: ${error.message}`);
        throw error;
    }
}

async function getAllFuturesSymbols(retryCount = 0) {
    const maxRetries = 5;
    const retryDelay = 7000;
    try {
        logVps1(`Attempting to get symbols and leverage data (attempt ${retryCount + 1}/${maxRetries + 1})...`);

        const [exchangeInfo, leverageBrackets] = await Promise.all([
            callPublicAPI('/fapi/v1/exchangeInfo'),
            callSignedAPI('/fapi/v1/leverageBracket', 'GET')
        ]);

        const totalPublicSymbols = exchangeInfo?.symbols?.length || 0;
        const totalLeverageSymbols = leverageBrackets?.length || 0;
        logVps1(`[DEBUG] exchangeInfo (public) returned ${totalPublicSymbols} symbols.`);
        logVps1(`[DEBUG] leverageBracket (signed) returned ${totalLeverageSymbols} symbols.`);
        if (totalLeverageSymbols < 250 && totalPublicSymbols > 300) {
            logVps1(`[WARNING] The number of symbols from leverageBracket is very low (${totalLeverageSymbols}) compared to public symbols. This strongly indicates a problem with API Key permissions (Enable Futures) or IP Whitelisting.`);
        }

        if (!exchangeInfo || !exchangeInfo.symbols || !Array.isArray(exchangeInfo.symbols)) {
            throw new Error("Invalid exchangeInfo data or missing symbols array.");
        }
        if (!leverageBrackets || !Array.isArray(leverageBrackets)) {
            throw new Error("Invalid leverageBracket data from Binance. This is often an API Key permission issue or IP restriction.");
        }

        const leverageMap = new Map();
        leverageBrackets.forEach(item => {
            if (item.brackets && item.brackets.length > 0) {
                leverageMap.set(item.symbol, item.brackets[0].initialLeverage);
            }
        });

        const symbols = exchangeInfo.symbols
            .filter(s =>
                s.contractType === 'PERPETUAL' &&
                s.quoteAsset === 'USDT' &&
                s.status === 'TRADING' &&
                (leverageMap.get(s.symbol) >= 50)
            )
            .map(s => s.symbol);

        logVps1(`Successfully fetched and filtered. Found ${symbols.length} USDT-M Futures symbols with max leverage > 50x.`);
        vps1DataStatus = "running_symbols_fetched";
        return symbols;
    } catch (error) {
        logVps1(`Error fetching symbols/leverage (attempt ${retryCount + 1}): ${error.message}`);
        if (retryCount < maxRetries) {
            logVps1(`Retrying in ${retryDelay / 1000} seconds...`);
            await new Promise(resolve => setTimeout(resolve, retryDelay));
            return getAllFuturesSymbols(retryCount + 1);
        } else {
            logVps1(`Failed to fetch symbols/leverage after ${maxRetries + 1} attempts.`);
            vps1DataStatus = "error_binance_symbols";
            topRankedCoinsForApi = [{ error_message: "VPS1: Could not fetch symbols/leverage from Binance after multiple retries. Check logs for details." }];
            return [];
        }
    }
}

async function fetchInitialHistoricalData(symbolsToFetch) {
    if (!symbolsToFetch || symbolsToFetch.length === 0) {
        logVps1("No symbols to fetch historical data for. Skipping.");
        if (allSymbols.length > 0 && vps1DataStatus === "running_symbols_fetched") {
             vps1DataStatus = "running_no_data_to_fetch_initially";
        }
        return;
    }
    logVps1(`Fetching initial historical data for ${symbolsToFetch.length} symbols...`);
    const now = Date.now();
    let fetchedAnyData = false;

    for (const symbol of symbolsToFetch) {
        if (!coinData[symbol]) {
            coinData[symbol] = {
                symbol: symbol, prices: [], changePercent: null, currentPrice: null,
                priceXMinAgo: null, lastUpdate: 0, klineOpenTime: 0, maxLeverage: 0
            };
        }
        try {
            const klinesData = await callPublicAPI('/fapi/v1/klines', { symbol, interval: '1m', endTime: now, limit: WINDOW_MINUTES });
            if (klinesData && klinesData.length > 0) {
                coinData[symbol].prices = klinesData.map(k => parseFloat(k[4]));
                if (coinData[symbol].prices.length > 0) {
                    coinData[symbol].currentPrice = coinData[symbol].prices[coinData[symbol].prices.length - 1];
                    coinData[symbol].priceXMinAgo = coinData[symbol].prices[0];
                    fetchedAnyData = true;
                }
            } else {
                logVps1(`No klines data returned for ${symbol}.`);
            }
        } catch (error) {
            const errorMsg = error.message || "Unknown error";
            if (errorMsg.includes('400') || errorMsg.includes('404') || errorMsg.toLowerCase().includes("invalid symbol")) {
                logVps1(`Symbol ${symbol} invalid or no data. Removing.`);
                delete coinData[symbol];
                allSymbols = allSymbols.filter(s => s !== symbol);
            } else if (errorMsg.includes('429')) {
                logVps1(`Rate limited for ${symbol}. Retrying this symbol later.`);
                await new Promise(resolve => setTimeout(resolve, 10000));
                await fetchInitialHistoricalData([symbol]);
            } else {
                logVps1(`Error fetching historical data for ${symbol}: ${errorMsg}.`);
            }
        }
        await new Promise(resolve => setTimeout(resolve, 350));
    }
    logVps1("Initial historical data fetching complete.");
    if (fetchedAnyData) {
        calculateAndRank();
        if (vps1DataStatus !== "error_binance_symbols") vps1DataStatus = "running_data_available";
    } else if (vps1DataStatus === "running_symbols_fetched" && allSymbols.length > 0) {
        vps1DataStatus = "running_no_initial_data_ranked";
        logVps1("No historical data could be ranked, though symbols are available.");
    }
}

function connectToBinanceWebSocket(symbolsToStream) {
    if (wsClient && (wsClient.readyState === WebSocket.OPEN || wsClient.readyState === WebSocket.CONNECTING)) {
        logVps1("Closing existing WebSocket before reconnecting.");
        wsClient.removeAllListeners();
        wsClient.terminate();
        wsClient = null;
    }
    if (!symbolsToStream || symbolsToStream.length === 0) {
        logVps1("No symbols to stream. WebSocket not started.");
        return;
    }
    const streams = symbolsToStream.map(s => `${s.toLowerCase()}@kline_1m`).join('/');
    const url = `${BINANCE_WS_URL}${streams}`;
    logVps1(`Connecting to WebSocket for ${symbolsToStream.length} streams...`);
    wsClient = new WebSocket(url);

    wsClient.on('open', () => logVps1('WebSocket connection successful.'));

    wsClient.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());
            if (message.data && message.data.e === 'kline') {
                const klineData = message.data.k;
                const symbol = klineData.s;

                if (coinData[symbol] && klineData.x) {
                    const closePrice = parseFloat(klineData.c);
                    const openTime = parseInt(klineData.t);

                    if (openTime > (coinData[symbol].klineOpenTime || 0)) {
                        coinData[symbol].prices.push(closePrice);
                        if (coinData[symbol].prices.length > WINDOW_MINUTES) {
                            coinData[symbol].prices.shift();
                        }
                        coinData[symbol].currentPrice = closePrice;
                        coinData[symbol].priceXMinAgo = coinData[symbol].prices[0];
                        coinData[symbol].lastUpdate = Date.now();
                        coinData[symbol].klineOpenTime = openTime;
                    }
                }
            }
        } catch (error) {
            logVps1(`Error processing WebSocket message: ${error.message}.`);
        }
    });

    wsClient.on('error', (error) => logVps1(`WebSocket error: ${error.message}`));

    wsClient.on('close', (code, reason) => {
        logVps1(`WebSocket closed. Code: ${code}, Reason: ${reason ? reason.toString().substring(0,100) : 'N/A'}. Reconnecting in 5s...`);
        setTimeout(() => connectToBinanceWebSocket(allSymbols), 5000);
    });
}

function calculateAndRank() {
    const rankedForApiOutput = [];
    let hasValidDataForRanking = false;

    for (const symbol in coinData) {
        const data = coinData[symbol];
        if (data.prices && data.prices.length >= (WINDOW_MINUTES - 5) && data.priceXMinAgo && data.currentPrice && data.priceXMinAgo > 0) {
            const change = ((data.currentPrice - data.priceXMinAgo) / data.priceXMinAgo) * 100;

            const coinEntryForApi = {
                symbol: data.symbol,
                changePercent: parseFloat(change.toFixed(2)),
                currentPrice: data.currentPrice,
                priceXMinAgo: data.priceXMinAgo,
                candles: data.prices.length,
                lastUpdate: data.lastUpdate ? new Date(data.lastUpdate).toISOString() : null
            };
            rankedForApiOutput.push(coinEntryForApi);
            hasValidDataForRanking = true;
        }
    }

    rankedForApiOutput.sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent));
    topRankedCoinsForApi = rankedForApiOutput.slice(0, 2000);

    if (hasValidDataForRanking) {
        if (vps1DataStatus !== "error_binance_symbols") vps1DataStatus = "running_data_available";
    }
}

async function periodicallyUpdateSymbolList() {
    logVps1("Periodically checking and updating symbol list...");
    const newSymbols = await getAllFuturesSymbols();

    if (vps1DataStatus === "error_binance_symbols") {
        logVps1("Failed to fetch new symbols in periodic update.");
        return;
    }
     if (newSymbols.length === 0 && allSymbols.length > 0) {
        logVps1("Periodic update fetched 0 symbols. Keeping old list for safety.");
        return;
    }

    const addedSymbols = newSymbols.filter(s => !allSymbols.includes(s));
    const removedSymbols = allSymbols.filter(s => !newSymbols.includes(s));

    let listChanged = false;
    if (addedSymbols.length > 0) {
        logVps1(`Detected ${addedSymbols.length} new symbols: ${addedSymbols.join(', ')}.`);
        allSymbols.push(...addedSymbols);
        await fetchInitialHistoricalData(addedSymbols);
        listChanged = true;
    }
    if (removedSymbols.length > 0) {
         logVps1(`Detected ${removedSymbols.length} removed symbols: ${removedSymbols.join(', ')}.`);
         removedSymbols.forEach(s => {
             delete coinData[s];
             delete claimedCoins[s];
             allSymbols = allSymbols.filter(sym => sym !== s);
         });
         listChanged = true;
    }

    if (listChanged) {
        logVps1(`Symbol list updated. Total: ${allSymbols.length}. Reconnecting WebSocket and re-ranking.`);
        connectToBinanceWebSocket(allSymbols);
        calculateAndRank();
    } else {
        logVps1("No changes in symbol list.");
    }
    logVps1("Symbol list check complete.");
}

async function main() {
    logVps1("VPS1 Data Provider is starting...");
    try {
        await syncServerTime();
    } catch(e) {
        logVps1(`CRITICAL: Could not sync time with Binance. Exiting. Error: ${e.message}`);
        process.exit(1);
    }
    
    allSymbols = await getAllFuturesSymbols();

    if (vps1DataStatus === "error_binance_symbols" || allSymbols.length === 0) {
        logVps1("CRITICAL: Could not fetch initial symbols or no symbols available with leverage > 50x.");
    } else {
        await fetchInitialHistoricalData([...allSymbols]);
        connectToBinanceWebSocket([...allSymbols]);
        calculateAndRank();
    }

    setInterval(calculateAndRank, 15 * 1000);
    setInterval(periodicallyUpdateSymbolList, 1 * 60 * 60 * 1000);

    app.post('/update_status', (req, res) => {
        const { bot_id, ...statusData } = req.body;
        if (!bot_id) {
            return res.status(400).json({ success: false, message: "Thiếu 'bot_id'." });
        }
        botStatus[bot_id] = { ...statusData, last_update: Date.now() };
        res.status(200).json({ success: true, message: `Trạng thái của ${bot_id} đã được cập nhật.` });
    });

    app.get('/claimed_coins', (req, res) => {
        logVps1(`[INFO] Request to /claimed_coins. Returning ${Object.keys(claimedCoins).length} coins.`);
        res.status(200).json({
             status: "success",
             count: Object.keys(claimedCoins).length,
             claimed_by_bot: claimedCoins
        });
    });

    app.post('/claim_coin', (req, res) => {
        const { coin, bot_id } = req.body;
        if (!coin || !bot_id) {
            return res.status(400).json({ success: false, message: "Thiếu 'coin' hoặc 'bot_id'." });
        }
    
        for (const existingCoin in claimedCoins) {
            if (claimedCoins[existingCoin] === bot_id) {
                if (existingCoin !== coin) {
                    delete claimedCoins[existingCoin];
                    logVps1(`[AUTO-RELEASE] Tự động giải phóng ${existingCoin} cho bot '${bot_id}' trước khi chiếm coin mới.`);
                }
            }
        }
    
        if (claimedCoins[coin] && claimedCoins[coin] !== bot_id) {
            logVps1(`[REJECTED] Bot '${bot_id}' cố gắng chiếm coin ${coin} đã bị '${claimedCoins[coin]}' chiếm.`);
            return res.status(409).json({ success: false, message: `Coin ${coin} đã bị chiếm bởi ${claimedCoins[coin]}.` });
        }
    
        claimedCoins[coin] = bot_id;
        logVps1(`[CLAIMED] Bot '${bot_id}' đã chiếm thành công coin ${coin}.`);
        res.status(200).json({ success: true, message: `Bot ${bot_id} đã chiếm thành công ${coin}.` });
    });

    app.post('/release_coin', (req, res) => {
        const { coin, bot_id } = req.body;
        if (!coin || !bot_id) {
            return res.status(400).json({ success: false, message: "Thiếu 'coin' hoặc 'bot_id'." });
        }
        if (claimedCoins[coin] && claimedCoins[coin] !== bot_id) {
             logVps1(`[INVALID RELEASE] Bot '${bot_id}' cố gắng giải phóng coin ${coin} đang do '${claimedCoins[coin]}' quản lý.`);
            return res.status(403).json({ success: false, message: `Bot ${bot_id} không có quyền giải phóng coin do ${claimedCoins[coin]} quản lý.` });
        }
        if (claimedCoins[coin]) {
            delete claimedCoins[coin];
            logVps1(`[RELEASED] Bot '${bot_id}' đã giải phóng coin ${coin}.`);
            res.status(200).json({ success: true, message: `Coin ${coin} đã được giải phóng.` });
        } else {
            logVps1(`[INFO] Bot '${bot_id}' gửi yêu cầu giải phóng cho coin ${coin} không có trong danh sách.`);
            res.status(200).json({ success: true, message: `Coin ${coin} không có trong danh sách, không cần giải phóng.` });
        }
    });
    
    app.get('/', (req, res) => {
        const indexPath = path.join(__dirname, 'sever.html');
        const isBrowserRequest = req.headers.accept && req.headers.accept.includes('text/html');

        if (isBrowserRequest && fs.existsSync(indexPath)) {
            res.sendFile(indexPath);
            return;
        }

        const requestingBotId = req.query.bot_id;

        const availableCoins = topRankedCoinsForApi.filter(coin => {
            const claimedBy = claimedCoins[coin.symbol];
            return !claimedBy || claimedBy === requestingBotId;
        });
        
        const runningCoins = [];
        for (const symbol in claimedCoins) {
            const bot_id = claimedCoins[symbol];
            const coinInfo = topRankedCoinsForApi.find(c => c.symbol === symbol);
            const statusInfo = botStatus[bot_id] || {};

            runningCoins.push({
                bot_id: bot_id,
                symbol: symbol,
                changePercent: coinInfo ? coinInfo.changePercent : 'N/A',
                net_pnl: statusInfo.net_pnl,
                cumulative_pnl: statusInfo.cumulative_pnl,
                bot_mode: statusInfo.bot_mode || 'N/A',
                last_update: statusInfo.last_update
            });
        }
        runningCoins.sort((a, b) => a.bot_id.localeCompare(b.bot_id));
        
        const responsePayload = {
            status: vps1DataStatus,
            message: `Trạng thái server: ${runningCoins.length} coin(s) đang chạy, ${availableCoins.length} coin(s) khả dụng cho bot '${requestingBotId || 'UNKNOWN'}'.`,
            running_coins: runningCoins,
            data: availableCoins
        };
        
        res.status(200).json(responsePayload);
    });

    setInterval(() => {
        const now = Date.now();
        const STALE_TIMEOUT = 1 * 60 * 1000;
        
        logVps1("Đang kiểm tra các bot mất kết nối...");
        for (const bot_id in botStatus) {
            if (now - (botStatus[bot_id].last_update || 0) > STALE_TIMEOUT) {
                logVps1(`Phát hiện bot ${bot_id} mất kết nối. Tự động giải phóng coin...`);
                const coinToRelease = Object.keys(claimedCoins).find(key => claimedCoins[key] === bot_id);
                if (coinToRelease) {
                    delete claimedCoins[coinToRelease];
                    logVps1(`Đã giải phóng coin ${coinToRelease} từ bot ${bot_id}.`);
                }
                delete botStatus[bot_id];
            }
        }
    }, 60 * 1000);

    http.createServer(app).listen(port, '0.0.0.0', () => {
        logVps1(`Server (HTTP) is running on port ${port}`);
        logVps1(`Dashboard served at: http://<YOUR_VPS1_IP>:${port}/`);
        logVps1(`Claimed coins status at: http://<YOUR_VPS1_IP>:${port}/claimed_coins`);
    });
}

main().catch(error => {
    logVps1(`CRITICAL UNHANDLED ERROR IN MAIN: ${error.message} ${error.stack}`);
    process.exit(1);
});
