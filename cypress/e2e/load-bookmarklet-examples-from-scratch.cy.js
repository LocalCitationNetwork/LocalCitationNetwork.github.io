describe('Load examples from scratch', () => {
  it('Load example from scratch: Amazon deforestation (S2)', () => {
    cy.visit('./index.html?API=Semantic%20Scholar&source=10.1038/S41558-022-01287-8&listOfIds=10.1073/PNAS.0705414105,10.1146/ANNUREV.ENERGY.28.050302.105532,10.1126/SCIENCE.1146961,10.1038/S41586-021-03629-6,10.1038/NATURE14283,10.1002/2015GB005133,10.1038/S41586-020-2035-0,10.1038/SREP41489,10.1038/35041539,10.1038/NATURE06960,10.1126/SCIADV.AAT2340,10.1126/SCIADV.ABA2949,10.1073/PNAS.1305499111,10.1111/J.1461-0248.2010.01497.X,10.1029/WR015I005P01250,10.1038/NGEO555,10.1111/GCB.13733,10.1038/NGEO1741,10.1016/S0304-3800(96)00034-8,10.1111/J.1365-2486.2009.02157.X,10.1111/J.1365-2486.2008.01626.X,10.1007/BF00384470,10.1038/NATURE08227,10.1038/307321A0,10.1073/PNAS.0802430105,10.1029/2004GL020972,10.1007/S12080-013-0191-7,10.1038/NCLIMATE1143,10.1073/PNAS.0811729106,10.1073/PNAS.2024192118,10.1038/S41558-021-01097-4,10.1038/NCLIMATE3108,10.5194/ESSD-12-177-2020,10.7289/V5ZG6QH9,10.1038/NCLIMATE2581,10.1038/386698A0,10.5067/MODIS/MCD12C1.006,10.1016/J.RSE.2016.02.056,10.1073/PNAS.1617988114,10.1038/SDATA.2015.66,10.1038/NCOMMS15519,10.1073/PNAS.1302584110,10.3389/FEART.2018.00228,10.1029/2018JD029537,10.1002/JOC.6335,10.1126/SCIENCE.1200807,10.1038/S41598-017-05373-2,10.1088/1748-9326/AB9CFF,10.1029/2002JD002670,10.1111/GCB.14413,585bf445ec84c1d9621b2726bdcce9f544b515c8,10.1175/JCLI-D-15-0828.1,10.1038/S41467-018-04881-7,10.1126/SCIENCE.1244693,10.1890/11-0889.1,10.3334/ORNLDAAC/1284,10.5281/ZENODO.5837469&bookmarkletURL=https://www.nature.com/articles/d41586-019-00857-9')
    
    cy.get('button').contains('Import').click()

    cy.window().its('app.__vue__').should(($vue) => {
      expect($vue.isLoading).to.be.true;
    })
    
    cy.waitUntil(() => cy.window().then(win => win.app.__vue__.isLoading === false), {
      timeout: 30000,
      interval: 5000
    })

    cy.get('#app').should(($app) => {
      expect($app[0].__vue__.currentGraph.seedArticles.length).to.equal(58);
    })

    cy.waitUntil(() => cy.window().then(win => win.app.__vue__.currentGraph.citedArticles !== undefined), {
      timeout: 30000,
      interval: 5000
    })

    cy.get('#app').should(($app) => {
      expect($app[0].__vue__.currentGraph.citedArticles.length).to.equal(10);
    })

    cy.waitUntil(() => cy.window().then(win => win.app.__vue__.currentGraph.citingArticles !== undefined), {
      timeout: 30000,
      interval: 5000
    })

    cy.get('#app').should(($app) => {
      expect($app[0].__vue__.currentGraph.citingArticles.length).to.equal(10);
    })
  })

  it('Load example from scratch: Medicine meta-research (OA)', () => {
    cy.visit('./index.html?API=OpenAlex&source=10.1371/JOURNAL.PMED.0020124&listOfIds=pmid:11302887,pmid:15158637,pmid:15158638,pmid:15705458,pmid:11600885,pmid:12642066,pmid:12727138,pmid:15705441,pmid:11159626,pmid:15026468,pmid:10866211,ISBN-13-978-0195083774,pmid:15470193,pmid:6528136,pmid:10694730,pmid:7618077,pmid:10521349,pmid:11323066,pmid:15545678,pmid:10532877,pmid:10584742,pmid:10789670,pmid:10755072,pmid:8015123,pmid:15161896,pmid:9693346,pmid:11405896,pmid:1535110,pmid:15878467,pmid:14602436,pmid:15057290,10.1093/BIOMET/44.1-2.187,10.1093/BIOMET/44.3-4.533,pmid:11434499,10.1056/NEJME048225,pmid:16014596,pmid:14584715&bookmarkletURL=https://pubmed.ncbi.nlm.nih.gov/16060722/')
    
    cy.get('button').contains('Import').click()

    cy.window().its('app.__vue__').should(($vue) => {
      expect($vue.isLoading).to.be.true;
    })
    
    cy.waitUntil(() => cy.window().then(win => win.app.__vue__.isLoading === false), {
      timeout: 30000,
      interval: 5000
    })

    cy.get('#app').should(($app) => {
      expect($app[0].__vue__.currentGraph.seedArticles.length).to.equal(38);
    })

    cy.waitUntil(() => cy.window().then(win => win.app.__vue__.currentGraph.citedArticles !== undefined), {
      timeout: 30000,
      interval: 5000
    })

    cy.get('#app').should(($app) => {
      expect($app[0].__vue__.currentGraph.citedArticles.length).to.equal(10);
    })

    cy.waitUntil(() => cy.window().then(win => win.app.__vue__.currentGraph.citingArticles !== undefined), {
      timeout: 30000,
      interval: 5000
    })

    cy.get('#app').should(($app) => {
      expect($app[0].__vue__.currentGraph.citingArticles.length).to.equal(10);
    })
  })

  it('Load example from scratch: Statistics (OC)', () => {
    cy.visit('./index.html?API=OpenCitations&source=10.1038/D41586-019-00857-9&listOfIds=10.1038/136474B0,10.1016/J.IJCARD.2014.09.205,10.1080/00031305.2019.1583913,10.1080/00031305.2018.1543616,10.1007/0-387-27605-X,10.1177/2515245918771329,10.1093/AJE/KWX259,10.1080/00031305.2018.1527253,10.1511/2014.111.460,10.1080/00031305.2018.1543137&bookmarkletURL=https://www.nature.com/articles/d41586-019-00857-9')
    
    cy.get('button').contains('Import').click()

    cy.window().its('app.__vue__').should(($vue) => {
      expect($vue.isLoading).to.be.true;
    })
    
    cy.waitUntil(() => cy.window().then(win => win.app.__vue__.isLoading === false), {
      timeout: 30000,
      interval: 5000
    })

    cy.get('#app').should(($app) => {
      expect($app[0].__vue__.currentGraph.seedArticles.length).to.equal(11);
    })

    cy.waitUntil(() => cy.window().then(win => win.app.__vue__.currentGraph.citedArticles !== undefined), {
      timeout: 30000,
      interval: 5000
    })

    cy.get('#app').should(($app) => {
      expect($app[0].__vue__.currentGraph.citedArticles.length).to.equal(10);
    })

    cy.waitUntil(() => cy.window().then(win => win.app.__vue__.currentGraph.citingArticles !== undefined), {
      timeout: 30000,
      interval: 5000
    })

    cy.get('#app').should(($app) => {
      expect($app[0].__vue__.currentGraph.citingArticles.length).to.equal(10);
    })
  })
})