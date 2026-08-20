module.exports = {
    instrument: {
        ticker: 'SBER',
        classCode: 'TQBR',
    },
    strategy: {
        type: 'constant-bid',
        quantity: 1,
        offsetPercent: 1,
        side: 'BUY',
        modifyThreshold: 0.05,
        minPrice: 0,
        maxPrice: 300,
    },
    orderQuantity: 1,
    priceOffsetPercent: 1,
    modifyOffsetPercent: 1.5,
    modifyThreshold: 0.05,
    forceModify: false,
};
