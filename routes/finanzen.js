'use strict';
const express = require('express');
const auth = require('../lib/auth');
const kz = require('../lib/kennzahlen');
const { schuetze } = require('../lib/kennungen');

const r = schuetze(express.Router());

r.get('/', auth.verlangt('admin', 'team'), async (req, res, next) => {
  try {
    const [k, verlauf, top, offen, retainer] = await Promise.all([
      kz.uebersicht(), kz.umsatzverlauf(12), kz.topKunden(10), kz.offenePosten(), kz.retainerAuslastung(),
    ]);
    res.render('finanzen', { titel: 'Finanzen', k, verlauf, top, offen, retainer });
  } catch (e) { next(e); }
});

module.exports = r;
