var configuration = require('./configuration');
var request = require('https');
var Web3 = require('web3');
var fs = require('fs');
var gasCalculator = require('./gasCalculator');
var web3 = new Web3(configuration.blockchainConnectionString);
var address = web3.eth.accounts.privateKeyToAccount(configuration.privateKey).address;
var privateKey = Buffer.from(configuration.privateKey, 'hex');
var Transaction = require('ethereumjs-tx');
Transaction = Transaction.Transaction || Transaction;
var voidEthereumAddress = "0x0000000000000000000000000000000000000000";

var uniswapV2Router = new web3.eth.Contract(configuration.uniswapV2RouterABI, configuration.uniswapV2RouterAddress);
var uniswapV2Factory = new web3.eth.Contract(configuration.uniswapV2FactoryABI, configuration.uniswapV2FactoryAddress);

async function start() {
    loop();
}

async function loop() {
    if(hasReachTodayLimits()) {
        return setTimeout(loop, calculateNextDayTimeout());
    }
    var chainId = await web3.eth.net.getId();
    var uniswapPairs = await loadUniswapPairsOfProgrammableTokens(chainId);
    var conveniences = [];
    var dfoProxy = new web3.eth.Contract(configuration.DFOProxyABI, configuration.dfoProxyAddress);
    var walletAddress = await dfoProxy.methods.getMVDWalletAddress().call();
    for(var uniswapPair of uniswapPairs) {
        conveniences.push(...(await getConveniences(walletAddress, chainId, uniswapPair, uniswapPair.token0)));
        conveniences.push(...(await getConveniences(walletAddress, chainId, uniswapPair, uniswapPair.token1)));
    }
    var amount = '0';
    for(var convenience of conveniences) {
        try {
            amount = web3.utils.toBN(amount).add(web3.utils.toBN(await sendTransaction(dfoProxy, convenience))).toString();
        } catch(e) {
            console.error(e);
        }
    }
    conveniences.length > 0 && dumpTodayLimits(amount);
    if(hasReachTodayLimits()) {
        return setTimeout(loop, calculateNextDayTimeout());
    }
    return setTimeout(loop, configuration.dailyTimeTimeout);
}

function sendTransaction(dfoProxy, convenience) {
    var deadline = numberToString((new Date().getTime() / 1000) + configuration.swapDeadline).split('.')[0];
    return new Promise(async (ok, ko) => {
        var tx = {};
        var nonce = await web3.eth.getTransactionCount(address);
        nonce = web3.utils.toHex(nonce);
        tx.nonce = nonce;
        tx.from = address;
        tx.data = dfoProxy.methods.submit('quickScope', web3.eth.abi.encodeParameters(['address', 'uint256', 'address', 'address[]', 'uint256', 'uint256', 'uint256'], [voidEthereumAddress, 0, configuration.uniswapV2RouterAddress, convenience.path.map(it => it.address), convenience.amountIn, convenience.amountOutWithSlippage, deadline])).encodeABI();
        tx.value = "0x0";
        tx.gasLimit = web3.utils.toHex(configuration.gasLimit);
        var gasPrice = await gasCalculator();
        gasPrice = web3.utils.toWei(gasPrice, 'gwei');
        gasPrice = web3.utils.toHex(gasPrice);
        tx.gasPrice = gasPrice;
        tx.to = dfoProxy.options.address;
        tx.chainId = web3.utils.toHex(await web3.eth.getChainId());
        var transaction = new Transaction(tx);
        transaction.sign(privateKey);
        var serializedTx = '0x' + transaction.serialize().toString('hex');
        web3.eth.sendSignedTransaction(serializedTx).on('transactionHash', transactionHash => {
            console.log(logTransaction(convenience, transactionHash));
            var timeout = async function() {
                var receipt = await web3.eth.getTransactionReceipt(transactionHash);
                if (!receipt || !receipt.blockNumber || parseInt(await web3.eth.getBlockNumber()) < (parseInt(receipt.blockNumber) + (configuration.transactionConfirmations || 0))) {
                    return setTimeout(timeout, configuration.transactionConfirmationsTimeoutMillis);
                }
                var doneTransaction = await web3.eth.getTransaction(transactionHash);
                var transactionCost = numberToString(parseInt(doneTransaction.gasPrice) * receipt.gasUsed);
                return ok(transactionCost);
            };
            setTimeout(timeout);
        }).catch(ko);
    });
}

function logTransaction(convenience, transactionHash) {
    var message = web3.utils.fromWei(convenience.amountIn, toEthereumSymbol(convenience.path[0].decimals));
    message += " ";
    message += convenience.path[0].symbol;
    message += " through ";
    message += convenience.path[1].symbol;
    message += ": ";
    message += web3.utils.fromWei(convenience.amountOut, toEthereumSymbol(convenience.path[0].decimals));
    message += " ";
    message += convenience.path[0].symbol;
    message += ": https://etherscan.io/tx/";
    message += transactionHash;
    return message;
}

function calculateNextDayTimeout() {
    var today = new Date()
    var tomorrow = new Date(today)
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0,0,0,0);
    return tomorrow.getTime() - today.getTime();
}

async function getConveniences(walletAddress, chainId, pair, selection) {
    var otherSelection = selection === pair.token0 ? pair.token1 : pair.token0;
    var amountIn = await calculateAmountInEquivalentDollars(selection.address);
    var balance = await new web3.eth.Contract(configuration.IERC20ABI, selection.address).methods.balanceOf(walletAddress).call();
    if(parseInt(amountIn) > parseInt(balance)) {
        return [];
    }
    var transferTokens = configuration.transferTokens.filter(it => it.chainId === chainId);
    var conveniences = [];
    for(var transferToken of transferTokens) {
        var path = [
            selection,
            otherSelection,
            transferToken,
            selection
        ];
        var amountOut = await uniswapV2Router.methods.getAmountsOut(amountIn, path.map(it => it.address)).call();
        amountOut = amountOut[amountOut.length - 1];
        var difference = web3.utils.toBN(amountOut).sub(web3.utils.toBN(amountIn)).toString();
        var priceGainPercentage = parseInt(amountIn) * configuration.priceGainPercentage;
        if(difference.indexOf("-") === 0 || parseInt(difference) < priceGainPercentage) {
            continue;
        }
        var amountOutWithSlippage = numberToString(parseInt(amountOut) - (parseInt(amountOut) * configuration.slippageCalculation));
        amountOutWithSlippage = numberToString(parseInt(amountIn) + (parseInt(amountIn) * configuration.slippageCalculation));
        conveniences.push({
            amountIn,
            path,
            amountOut,
            amountOutWithSlippage
        });
    }
    return conveniences;
}

async function loadUniswapPairsOfProgrammableTokens(chainId) {
    var programmableEquities = await loadProgrammableEquities(chainId);
    var tokenData = {};
    var addressesForLog = programmableEquities.map(it => web3.eth.abi.encodeParameter('address', it.address));
    programmableEquities.forEach(it => tokenData[it.address = web3.utils.toChecksumAddress(it.address)] = it);
    var additionalTokens = configuration.additionalTokens ? configuration.additionalTokens.filter(it => it.chainId === chainId) : undefined;
    additionalTokens && addressesForLog.push(...additionalTokens.map(it => web3.eth.abi.encodeParameter('address', it.address)));
    additionalTokens && programmableEquities.forEach(it => tokenData[it.address = web3.utils.toChecksumAddress(it.address)] = it);
    addressesForLog = configuration.preferredTokens ? configuration.preferredTokens.map(it => web3.eth.abi.encodeParameter('address', it)) : addressesForLog;

    var start = 0;
    var addressesList = [];
    while (start < addressesForLog.length) {
        var length = start + configuration.tokenArrayChunk;
        length = length > addressesForLog.length ? addressesForLog.length : length;
        addressesList.push(addressesForLog.slice(start, length));
        start = length;
    }
    var list = {};
    for (var addresses of addressesList) {
        for (var subList of addressesList) {
            var uniswapPairs = await global[configuration.uniswapPairsLoadMethod](addresses, subList);
            uniswapPairs.forEach(it => {
                it.token0 = tokenData[web3.utils.toChecksumAddress(it.token0)];
                it.token1 = tokenData[web3.utils.toChecksumAddress(it.token1)];
                list[it.options.address] = it;
            });
        }
    }
    return Object.values(list);
}

global.loadUniswapPairsByEvents = async function loadUniswapPairsByEvents(tokens, others) {
    var pairCreatedTopic = web3.utils.sha3('PairCreated(address,address,address,uint256)');
    var logs = await web3.eth.getPastLogs({
        address: configuration.uniswapV2FactoryAddress,
        fromBlock: configuration.uniswapV2FactoryStartBlock,
        topics: [
            pairCreatedTopic,
            tokens,
            others
        ]
    });
    logs.push(...(await web3.eth.getPastLogs({
        address: configuration.uniswapV2FactoryAddress,
        fromBlock: configuration.uniswapV2FactoryStartBlock,
        topics: [
            pairCreatedTopic,
            others,
            tokens
        ]
    })));
    var uniswapPairs = {};
    for (var log of logs) {
        var pairTokenAddress = web3.utils.toChecksumAddress(web3.eth.abi.decodeParameters(['address', 'uint256'], log.data)[0]);
        if (uniswapPairs[pairTokenAddress]) {
            continue;
        }
        var pairToken = new web3.eth.Contract(configuration.uniswapV2PairABI, pairTokenAddress);
        pairToken.token0 = web3.utils.toChecksumAddress(await pairToken.methods.token0().call());
        pairToken.token1 = web3.utils.toChecksumAddress(await pairToken.methods.token1().call());
        uniswapPairs[pairTokenAddress] = pairToken;
    }
    return Object.values(uniswapPairs);
}

global.loadUniswapPairsByFactory = async function loadUniswapPairsByFactory(tokens, others) {
    var uniswapPairs = {};
    for(var token of tokens) {
        for(var other of others) {
            var pairTokenAddress = await uniswapV2Factory.methods.getPair(web3.eth.abi.decodeParameter('address', token), web3.eth.abi.decodeParameter('address', other)).call();
            if (pairTokenAddress === voidEthereumAddress || uniswapPairs[pairTokenAddress]) {
                continue;
            }
            var pairToken = new web3.eth.Contract(configuration.uniswapV2PairABI, pairTokenAddress);
            pairToken.token0 = web3.utils.toChecksumAddress(await pairToken.methods.token0().call());
            pairToken.token1 = web3.utils.toChecksumAddress(await pairToken.methods.token1().call());
            uniswapPairs[pairTokenAddress] = pairToken;
        }
    }
    return Object.values(uniswapPairs);
}

async function loadProgrammableEquities(chainId) {
    var pe = await AJAXRequest(configuration.programmableEquitiesURL);
    return pe.tokens.filter(it => it.chainId === chainId);
}

function AJAXRequest(url) {
    return new Promise(function(ok) {
        request.get(url, res => {
            res.setEncoding("utf8");
            let body = "";
            res.on("data", data => {
                body += data;
            });
            res.on("end", () => {
                try {
                    body = JSON.parse(body);
                } catch(e) {
                }
                return ok(body);
            });
        });
    });
}

function toEthereumSymbol(decimals) {
    var symbols = {
        "noether": "0",
        "wei": "1",
        "kwei": "1000",
        "Kwei": "1000",
        "babbage": "1000",
        "femtoether": "1000",
        "mwei": "1000000",
        "Mwei": "1000000",
        "lovelace": "1000000",
        "picoether": "1000000",
        "gwei": "1000000000",
        "Gwei": "1000000000",
        "shannon": "1000000000",
        "nanoether": "1000000000",
        "nano": "1000000000",
        "szabo": "1000000000000",
        "microether": "1000000000000",
        "micro": "1000000000000",
        "finney": "1000000000000000",
        "milliether": "1000000000000000",
        "milli": "1000000000000000",
        "ether": "1000000000000000000",
        "kether": "1000000000000000000000",
        "grand": "1000000000000000000000",
        "mether": "1000000000000000000000000",
        "gether": "1000000000000000000000000000",
        "tether": "1000000000000000000000000000000"
    };
    var d = "1" + (new Array(decimals + 1)).join('0');
    var values = Object.entries(symbols);
    for (var i in values) {
        var symbol = values[i];
        if (symbol[1] === d) {
            return symbol[0];
        }
    }
}

function getTodayLimitsKey() {
    var date = new Date();
    var day = date.getDate();
    day <= 9 && (day = "0" + (day + ""));
    day = day + "";
    var month = (date.getMonth() + 1);
    month <= 9 && (month = "0" + (month + ""));
    month = month + "";
    var year = date.getFullYear() + "";
    return `${year}-${month}-${day}`;
}

function hasReachTodayLimits() {
    var limit = loadTodayLimits();
    var dailyExpenseWei = web3.utils.toWei(configuration.dailyExpense, "ether");
    if(parseInt(limit.expenses) >= parseInt(dailyExpenseWei)) {
        return true;
    }
    if(limit.times >= configuration.dailyTimes) {
        return true;
    }
    return false;
}

function loadTodayLimits() {
    return loadLimits(getTodayLimitsKey());
}

function loadLimits(key) {
    var limits = {};
    try {
        limits = JSON.parse(fs.readFileSync(configuration.limitsListFile, 'UTF-8'));
    } catch(e) {
    }
    return key ? (limits[key] || {"expenses" : "0", "times" : 0}) : limits;
}

function dumpTodayLimits(value) {
    var key = getTodayLimitsKey();
    var limits = loadLimits();
    var todayLimits = limits[key] || {"expenses" : "0", "times" : 0};
    todayLimits.expenses = web3.utils.toBN(todayLimits.expenses || '0').add(web3.utils.toBN(value)).toString();
    todayLimits.times++;
    limits[key] = todayLimits;
    fs.writeFileSync(configuration.limitsListFile, JSON.stringify(limits, null, 4));
}

function numberToString(num, locale) {
    if (num === undefined || num === null) {
        num = 0;
    }
    if ((typeof num).toLowerCase() === 'string') {
        return num;
    }
    let numStr = String(num);

    if (Math.abs(num) < 1.0) {
        let e = parseInt(num.toString().split('e-')[1]);
        if (e) {
            let negative = num < 0;
            if (negative) num *= -1
            num *= Math.pow(10, e - 1);
            numStr = '0.' + (new Array(e)).join('0') + num.toString().substring(2);
            if (negative) numStr = "-" + numStr;
        }
    } else {
        let e = parseInt(num.toString().split('+')[1]);
        if (e > 20) {
            e -= 20;
            num /= Math.pow(10, e);
            numStr = num.toString() + (new Array(e + 1)).join('0');
        }
    }
    if (locale === true) {
        var numStringSplitted = numStr.split(' ').join('').split('.');
        return parseInt(numStringSplitted[0]).toLocaleString() + (numStringSplitted.length === 1 ? '' : (Utils.decimalsSeparator + numStringSplitted[1]))
    }
    return numStr;
};

async function getEthereumPrice() {
    if (global.lastEthereumPrice && global.lastEthereumPrice.requestExpires > new Date().getTime() && global.lastEthereumPrice.price !== 0) {
        return global.lastEthereumPrice.price;
    }
    var price = 0;
    try {
        price = (await AJAXRequest(configuration.coingeckoEthereumPriceURL))[0].current_price;
    } catch (e) {}
    return (global.lastEthereumPrice = {
        price,
        requestExpires: new Date().getTime() + configuration.coingeckoEthereumPriceRequestInterval
    }).price;
}

async function calculateAmountInEquivalentDollars(tokenAddress) {
    var ethereumPrice = await getEthereumPrice();
    var amountIn = numberToString(configuration.singleTokenPriceInDollars / ethereumPrice);
    amountIn = web3.utils.toWei(amountIn, 'ether');
    var path = [
        await uniswapV2Router.methods.WETH().call(),
        tokenAddress
    ];
    return (await uniswapV2Router.methods.getAmountsOut(amountIn, path).call())[1];
}

start().catch(console.error);