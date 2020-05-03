/* Local Citation Network v0.94 (GPL-3) */
/* by Tim Wölfle */
/* https://timwoelfle.github.io/Local-Citation-Network */

/* global axios, vis, Vue, Buefy, localStorage */

'use strict'

const arrSum = arr => arr.reduce((a, b) => a + b, 0)
const arrAvg = arr => arrSum(arr) / arr.length

/* Crossref API */

function crossrefWorks (expression, response, count) {
  // Currently the crossref API doesn't fully support subselection of response, so just obtain full response (in particular reference data: https://gitlab.com/crossref/issues/issues/511)
  let body = {
    filter: expression,
    rows: count,
    offset: 0,
    mailto: 'local-citation-network@timwoelfle.de'
  }

  // Encode request body as URLencoded
  body = Object.keys(body).map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(body[k])
  }).join('&')

  return axios.get('https://api.crossref.org/works?' + body).then(response).catch(function (error) {
    vm.errorMessage('Error while processing data through Crossref API: ' + error + ' ' + (error.response && error.response.data && error.response.data.message && error.response.data.message[0] && error.response.data.message[0].message))
  })
}

function crossrefResponseToArticleArray (data, sourceReferences) {
  return data.message.items.map(function (article) {
    // filter is necessary because some references don't have DOIs in CrossRef (https://stackoverflow.com/questions/28607451/removing-undefined-values-from-array)
    const references = (typeof article.reference === 'object') ? article.reference.map(x => (x.DOI) ? x.DOI.toUpperCase() : undefined) : []

    return {
      id: article.DOI.toUpperCase(),
      // Crossref actually returns references in the original order (as opposed to MA)
      numberInSourceReferences: (sourceReferences.length) ? sourceReferences.indexOf(article.DOI.toUpperCase()) + 1 : undefined,
      doi: article.DOI.toUpperCase(),
      title: String(article.title), // most of the time title is an array with length=1, but I've also seen pure strings
      authors: (article.author && article.author.length) ? article.author.map(x => ({ LN: x.family || x.name, FN: x.given, affil: String(x.affiliation) || undefined })) : [{ LN: article.author || undefined }],
      year: article.issued['date-parts'] && article.issued['date-parts'][0] && article.issued['date-parts'][0][0],
      journal: String(article['container-title']),
      references: references || [],
      referencesCountTotal: article['references-count'], // Crossref also returns total number of references, including those without DOIs that are thus missing in references
      citationsCount: article['is-referenced-by-count'],
      abstract: article.abstract
    }
  })
}

/* Microsoft Academic (MA) API  */

function microsoftAcademicEvaluate (expression, response, count, apiKey = '') {
  let body = {
    expr: expression,
    model: 'latest',
    count: count,
    offset: 0,
    attributes: ['Id', 'DOI', 'DN', 'AA.DAuN', 'AA.DAfN', 'Y', 'BV', 'RId', 'ECC', 'CitCon', 'IA'].join(',')
  }

  // Encode request body as URLencoded
  body = Object.keys(body).map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(body[k])
  }).join('&')

  // return axios.get("https://api.labs.cognitive.microsoft.com/academic/v1.0/evaluate?" + body, {
  return axios.post('https://api.labs.cognitive.microsoft.com/academic/v1.0/evaluate', body, {
    headers: { 'Ocp-Apim-Subscription-Key': apiKey, 'Content-Type': 'application/x-www-form-urlencoded' }
  }).then(response).catch(function (error) {
    if (error.message === 'Network Error') {
      vm.errorMessage('Error while processing data through Microsoft Academic API. Check your connection or try Crossref.', 'Network Error')
    } else if (error.response && error.response.status === 401) {
      vm.useMA = false
      let errorMessage = 'Try again with Crossref, Microsoft Academic turned off.<br><br>'
      if (vm.customKeyMA) {
        errorMessage += 'Custom API key for Microsoft Academic (' + vm.customKeyMA + ') incorrect or monthly quota exhausted. <a href="https://msr-apis.portal.azure-api.net/products/project-academic-knowledge" target="_blank">Get your own free key here!</a>'
      } else {
        errorMessage += 'Test API key used by web app has exceeded monthly quota. <a href="https://msr-apis.portal.azure-api.net/products/project-academic-knowledge" target="_blank">Get your own free key here!</a>'
      }
      vm.errorMessage(errorMessage, 'Authentication error')
      vm.customKeyMA = undefined
    } else {
      vm.useMA = false
      vm.errorMessage('Try again with Crossref, Microsoft Academic turned off.<br><br>Error while processing data through Microsoft Academic API: ' + error + ' ' + ((error.response) ? '(' + error.response.statusText + ' ' + (error.response.data && error.response.data.Error && error.response.data.Error.Message) + ')' : ''))
    }
  })
}

// API attributes documentation: https://docs.microsoft.com/en-us/azure/cognitive-services/academic-knowledge/paperentityattributes
function microsoftAcademicResponseToArticleArray (data, sourceReferences) {
  return data.entities.map(function (article) {
    return {
      id: article.Id,
      microsoftAcademicId: article.Id,
      // Microsoft Academic returns reference lists of papers as arrays sorted by "relevance" (close to global number of citations), not by order of references in original publication
      numberInSourceReferences: (article.DOI) ? ((sourceReferences.length) ? sourceReferences.indexOf(article.DOI.toUpperCase()) + 1 : undefined) : undefined,
      doi: (article.DOI) ? article.DOI.toUpperCase() : undefined, // some articles don't have DOIs
      title: article.DN,
      authors: article.AA.map(author => {
        if (!author.DAuN) return { LN: String(author) }
        const lastSpace = author.DAuN.lastIndexOf(' ')
        // Unfortunately, Microsoft Academic often has multiple author Ids for the same author name when affiliations differ => this leads to seeming redundancies
        return { LN: author.DAuN.substr(lastSpace + 1), FN: author.DAuN.substr(0, lastSpace), affil: author.DAfN || undefined }
      }),
      year: article.Y,
      journal: article.BV,
      references: article.RId || [],
      citationsCount: article.ECC,
      citationContext: article.CitCon,
      abstract: (article.IA) ? revertAbstractFromInvertedIndex(article.IA.InvertedIndex) : undefined
    }
  })
}

function revertAbstractFromInvertedIndex (InvertedIndex) {
  const abstract = []
  Object.keys(InvertedIndex).forEach(word => InvertedIndex[word].forEach(i => { abstract[i] = word }))
  return abstract.join(' ').replace('  ', ' ').trim()
}

/* vis.js Reference graph */

// I've tried keeping referenceNetwork in Vue's data, but it slowed things down a lot -- better keep it as global variable as network is not rendered through Vue anyway
let referenceNetwork, authorNetwork

function initReferenceNetwork (app) {
  const nodeIds = app.inputArticlesIds.concat(app.suggestedArticlesIds)

  // Create an array with edges
  const inDegree = {}
  const outDegree = {}
  const edges = app.currentGraph.input.map(function (article) {
    return (!article.references) ? [] : article.references.map(function (ref) {
      if (nodeIds.includes(ref)) {
        inDegree[ref] = (inDegree[ref]) ? inDegree[ref] + 1 : 1
        outDegree[article.id] = (outDegree[article.id]) ? outDegree[article.id] + 1 : 1

        return { from: article.id, to: ref }
      } else {
        return []
      }
    })
  }).flat(2)

  // Create an array with nodes only for nodes with in- / out-degree >= 1 (no singletons)
  const articles = app.currentGraph.input.concat(app.currentGraph.suggested).map(article => (!inDegree[article.id] && !outDegree[article.id]) ? [] : article).flat()

  // Sort by rank of year
  const years = Array.from(new Set(articles.map(article => article.year).sort()))

  const nodes = articles.map(article => ({
    id: article.id,
    title: vm.authorStringShort(article.authors) + ', <i>' + article.title + '</i>. ' + article.journal + ' ' + article.year + '.',
    level: years.indexOf(article.year),
    group: article.year,
    size: (inDegree[article.id] || 0 + 2) * 10,
    shape: (app.inputArticlesIds.includes(article.id)) ? 'dot' : 'star',
    label: article.authors[0].LN + '\n' + article.year
  }))

  // Create network
  const options = {
    layout: {
      hierarchical: {
        direction: 'DU',
        levelSeparation: 400
      }
    },
    nodes: {
      font: {
        size: 150
      }
    },
    edges: {
      color: {
        color: 'rgba(200,200,200,0.3)',
        inherit: false
      },
      arrows: {
        to: {
          enabled: true,
          scaleFactor: 4
        }
      }
    },
    physics: {
      hierarchicalRepulsion: {
        nodeDistance: 600
      }
    },
    configure: false
  }
  referenceNetwork = new vis.Network(document.getElementById('referenceNetworkDiv'), { nodes: nodes, edges: edges }, options)
  referenceNetwork.on('click', networkOnClick)
  referenceNetwork.on('doubleClick', networkOnDoubleClick)
  referenceNetwork.on('resize', function () { referenceNetwork.fit() })

  function networkOnClick (params) {
    let selectedNode

    // Select corresponding row in table
    if (params.nodes.length > 0) {
      selectedNode = params.nodes[0]
      // Input article node was clicked (circle)
      if (app.inputArticlesIds.includes(selectedNode)) {
        app.showSuggested = 0
        app.selectedInputArticle = app.currentGraph.input[app.inputArticlesIds.indexOf(selectedNode)]
        // Suggested article node was clicked (star)
      } else {
        app.showSuggested = 1
        app.selectedSuggestedArticle = app.currentGraph.suggested[app.suggestedArticlesIds.indexOf(selectedNode)]
      }
    }
  }

  function networkOnDoubleClick (params) {
    let selectedNode, article

    // Select corresponding row in table
    if (params.nodes.length > 0) {
      selectedNode = params.nodes[0]
      article = app.currentGraph.input[app.inputArticlesIds.indexOf(selectedNode)] || app.currentGraph.suggested[app.suggestedArticlesIds.indexOf(selectedNode)]
      window.open('https://doi.org/' + article.doi, '_blank')
    }
  }
}

function initAuthorNetwork (app, minPublications = undefined) {
  // authorGroups[0] is source
  // Unfortunately, Microsoft Academic often has multiple author Ids for the same author name when affiliations differ => this leads to seeming redundancies, which makes the new Set() necessary to have each author name be unique
  // (I know this can cause trouble with non-unique author names actually shared by two people publishing in similar fields but I'm currently not taking this into account)
  let authorGroups = [app.currentGraph.source].concat(app.currentGraph.input).concat(app.currentGraph.suggested).map(article => article.authors ? Array.from(new Set(article.authors.map(x => x.FN + ' ' + x.LN))) : [])
  const authors = {}
  let authorsWithMinPubs = []
  const links = {}

  // Get authors from more than one publication
  authorGroups.flat().forEach(author => { authors[author] = (authors[author] || 0) + 1 })

  if (!minPublications) {
    minPublications = 2
    authorsWithMinPubs = Object.keys(authors).filter(author => authors[author] >= minPublications)
    while (authorsWithMinPubs.length > 50) {
      minPublications++
      authorsWithMinPubs = Object.keys(authors).filter(author => authors[author] >= minPublications)
    }
    app.minPublications = minPublications
  } else {
    authorsWithMinPubs = Object.keys(authors).filter(author => authors[author] >= minPublications)
  }

  authorGroups = authorGroups.map(group => group.filter(author => authorsWithMinPubs.includes(author)))

  authorGroups.forEach(group => group.forEach(indiv1 => group.forEach(indiv2 => {
    if (indiv1 === indiv2) return false

    // Is there already a link for this pair? If so, make it stronger
    if (links[indiv1] && links[indiv1][indiv2]) return links[indiv1][indiv2]++
    if (links[indiv2] && links[indiv2][indiv1]) return links[indiv2][indiv1]++

    // Create new link
    if (!links[indiv1]) links[indiv1] = {}
    links[indiv1][indiv2] = 1
  })))

  const edges = Object.keys(links).map(indiv1 => Object.keys(links[indiv1]).map(indiv2 => {
    return { from: indiv1, to: indiv2, value: links[indiv1][indiv2], title: indiv1 + ' & ' + indiv2 + '<br>(' + links[indiv1][indiv2] / 2 + ' collaboration(s) among source, input & suggested articles)' }
  })).flat(2)

  const nodes = authorsWithMinPubs.map(author => {
    return {
      id: author,
      title: author + ((authorGroups[0].includes(author)) ? ' ((co)author of source article)<br>(' : '<br>(') + (authorGroups[0].includes(author) ? authors[author] - 1 : authors[author]) + ' publication(s) among input & suggested articles)',
      group: authorGroups.map(group => group.includes(author)).indexOf(true),
      label: author.substr(author.lastIndexOf(' ') + 1),
      size: authors[author] * 3,
      shape: (authorGroups[0].includes(author)) ? 'diamond' : 'dot'
    }
  })

  // create a network
  const options = {
    nodes: {
      font: {
        size: 20
      }

    },
    edges: {
      color: {
        color: 'rgba(200,200,200,0.3)'
      },
      smooth: false
    },
    physics: {
      maxVelocity: 20
    },
    interaction: {
      dragNodes: true,
      multiselect: true,
      hideEdgesOnDrag: true,
      hideEdgesOnZoom: true
    },
    configure: false
  }
  authorNetwork = new vis.Network(document.getElementById('authorNetwork'), { nodes: nodes, edges: edges }, options)
  authorNetwork.on('click', networkOnClick)
  authorNetwork.on('resize', function () { authorNetwork.fit() })

  function networkOnClick (params) {
    app.filterColumn = 'authors'

    // If no node is clicked...
    if (!params.nodes.length) {
      // Maybe an edge?
      if (params.edges.length) {
        const edge = authorNetwork.body.data.edges.get(params.edges[0])
        app.highlightNodes([edge.from, edge.to])
        app.filterString = '(?=.*' + edge.from + ')(?=.*' + edge.to + ')'
        return app.filterString
        // Otherwise reset filterString
      } else {
        app.filterString = undefined
        return false
      }
    }

    // If just one node is selected perform simple filter for that author
    if (params.nodes.length === 1) {
      app.filterString = params.nodes[0]
      // If more than one node are selected, perform "boolean and" in regular expression through lookaheads, which means order isn't important (see https://www.ocpsoft.org/tutorials/regular-expressions/and-in-regex/)
    } else {
      app.filterString = '(?=.*' + params.nodes.join(')(?=.*') + ')'
    }

    app.highlightNodes(params.nodes)
  }
}

/* App logic */

Vue.use(Buefy)

const vm = new Vue({
  el: '#app',
  data: {
    // Settings
    useMA: true, // Use Micrsoft Academic API as default
    customKeyMA: undefined,
    maxTabs: 5,
    autosaveResults: false,

    // Data
    graphs: [],
    newSourceDOI: undefined,
    file: undefined,
    listOfDOIs: [],
    listName: undefined,

    // UI
    fullscreenNetwork: false,
    filterColumn: 'titleAbstract',
    filterString: undefined,
    selectedInputArticle: undefined,
    selectedSuggestedArticle: undefined,
    currentGraphIndex: undefined,
    showSuggested: 0,
    showAuthorNetwork: 0,
    minPublications: 2,
    isLoading: false,
    showFAQ: false,
    indexFAQ: 'about',
    editListOfDOIs: false
  },
  computed: {
    editedListOfDOIs: {
      get: function () { return this.listOfDOIs.join('\n') },
      set: function (x) { this.listOfDOIs = x.split('\n') }
    },
    currentGraph: function () {
      if (this.currentGraphIndex === undefined) return { source: {}, input: [], suggested: [] }
      return this.graphs[this.currentGraphIndex]
    },
    inputArticlesFiltered: function (articles) {
      return this.filterArticles(this.currentGraph.input)
    },
    inputArticlesIds: function () {
      return this.currentGraph.input.map(article => article.id)
    },
    suggestedArticlesIds: function () {
      return this.currentGraph.suggested.map(article => article.id)
    },
    suggestedArticlesFiltered: function (articles) {
      return this.filterArticles(this.currentGraph.suggested)
    },
    selected: function () {
      return this.showSuggested ? this.selectedSuggestedArticle : this.selectedInputArticle
    },

    // The following are for the estimation of the completeness of the data
    sourceReferencesCompletenessFraction: function () {
      return (this.currentGraph.source.referencesCountTotal) ? this.currentGraph.input.length / this.currentGraph.source.referencesCountTotal : 1
    },
    inputHasReferences: function () {
      return arrSum(this.currentGraph.input.map(x => x.references.length !== 0))
    },
    inputReferencesCompletenessFraction: function () {
      return arrAvg(this.currentGraph.input.filter(x => x.references.length !== 0).map(x => x.references.length / (x.referencesCountTotal || x.references.length)))
    },
    completenessLabel: function () {
      let label
      if (this.currentGraph.source.referencesCountTotal && this.currentGraph.source.referencesCountTotal !== this.currentGraph.input.length) {
        label = `${this.currentGraph.input.length} of originally ${this.currentGraph.source.referencesCountTotal} references were found in ${this.currentGraph.API} (${Math.round(this.sourceReferencesCompletenessFraction * 100)}%), ${this.inputHasReferences} of which have reference-lists themselves (${Math.round(this.inputHasReferences / this.currentGraph.input.length * 100)}%). `
      } else {
        label = `${this.inputHasReferences} of ${this.currentGraph.input.length} input articles have reference-lists themselves in ${this.currentGraph.API} (${Math.round(this.inputHasReferences / this.currentGraph.input.length * 100)}%). `
      }
      if (this.currentGraph.API === 'Crossref') label += `Their respective average reference completeness is ${Math.round(this.inputReferencesCompletenessFraction * 100)}%.`
      return label
    },
    completenessPercent: function () {
      return Math.round(this.sourceReferencesCompletenessFraction * this.inputHasReferences / this.currentGraph.input.length * this.inputReferencesCompletenessFraction * 100)
    }
  },
  watch: {
    // Initialize graph when new tab is opened / tab is changed
    currentGraphIndex: function () {
    // Reset filterString when tab is changed
      this.filterString = undefined

      // Don't know how to prevent this from firing (and thus causing a reinit) when closing a tab (only noticeable by a short flicker of the network, thus not a real issue)
      if (this.graphs.length) {
        this.init()
      }
    },
    // User provided a new DOI for source article
    // Here's what happens afterwards, in total 3 API calls:
    // watch:newSourceDOI => callAPI() for source article => setNewSource() => callAPI() for Input articles & callAPI() for Suggested articles => watch:currentGraph => init()
    newSourceDOI: function () {
      if (!this.newSourceDOI || !this.newSourceDOI.trim()) return false

      let DOI = this.newSourceDOI.trim().toUpperCase()

      // Ignore trailing string (e.g. 'doi:' or 'https://doi.org/')
      if (!DOI.match(/10\.\d{4,9}\/.+/)) return this.errorMessage(DOI + ' is not a valid DOI, which must be in the form: 10.prefix/suffix where prefix is 4 or more digits and suffix is a string.', 'Invalid DOI')
      else DOI = DOI.match(/10\.\d{4,9}\/.+/)[0]

      // Check if DOI is among open tabs already
      const graphDOIs = this.graphs.map(graph => graph.source.doi)
      if (graphDOIs.includes(DOI)) {
        this.currentGraphIndex = graphDOIs.indexOf(DOI)
      // Otherwise set new source DOI
      } else {
        this.isLoading = true
        this.callAPI([DOI], response => {
          this.setNewSource(this.responseToArray(response.data)[0])
        }, 1)
      }
    },
    // User provided a file which is searched for DOIs
    // Here's what happens afterwards, in total 2 API calls (similar to watch:newSourceDOI except that the first of three API calls to grab the source is omitted):
    // watch:file => setNewSource() => callAPI() for Input articles & callAPI() for Suggested articles => watch:currentGraph => init()
    file: function () {
      if (!this.file || !this.file.name) return false
      this.isLoading = true
      this.file.text().then(text => {
        this.isLoading = false
        // Using the set [-_;()/:A-Z0-9] twice (fullstop . and semicolon ; only in first set) makes sure that the trailing character is not a fullstop or semicolon
        const dois = Array.from(new Set(text.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+[-_()/:A-Z0-9]+/gi))).map(x => x.toUpperCase())
        if (!dois.length) throw new Error('No DOIs found in file.')
        this.listOfDOIs = dois
        this.listName = this.file.name
        this.editListOfDOIs = true
        // this.setNewSource({ references: dois, referencesCountTotal: dois.length }, this.file.name, this.file.name)
      }).catch(e => this.errorMessage('Error with file handling: ' + e))
    },
    // A different node (reference) in the graph has been selected
    selected: function () {
      if (!this.selected) return false

      // Highlight the right network node
      this.highlightNodes()

      // Scroll to right row
      if (document.getElementById(this.selected.id)) document.getElementById(this.selected.id).scrollIntoView({ behavior: 'smooth', block: 'center' })
    },
    showAuthorNetwork: function () {
      this.highlightNodes()
    },
    minPublications: function () {
      initAuthorNetwork(this, this.minPublications)
      this.highlightNodes()
    },
    editListOfDOIs: function () {
      document.getElementById('dois').scrollTop = document.getElementById('dois').scrollTopMax
    }
  },
  methods: {
    setNewSource: function (source, label = undefined, title = undefined) {
      try {
        // Some papers are in Crossref / MA but don't have references themselves
        if (!source) throw new Error(`DOI ${this.newSourceDOI} not found in ${(this.useMA) ? 'Microsoft Academic' : 'Crossref'} API, try other API.`)
        if (!source.references.length) throw new Error(`No references found in ${(this.useMA) ? 'Microsoft Academic' : 'Crossref'} API for paper with DOI: ${this.newSourceDOI}`)

        this.$buefy.toast.open({
          message: 'New query sent to ' + ((this.useMA) ? 'Microsoft Academic' : 'Crossref') + '.<br>This may take a while, depending on the number of references and API workload.',
          duration: 4000,
          queue: false
        })

        // Get Input articles
        // filter(Boolean) is necessary because references array can contain empty items in order to preserve original order of DOIs from crossref
        this.callAPI(source.references.filter(Boolean), response => {
          const referenced = {}
          const inputArticles = this.responseToArray(response.data, source.references)
          const inputArticlesIds = inputArticles.map(article => article.id)

          inputArticles.forEach(function (article) {
            article.references.filter(Boolean).forEach(function (refId) {
              if (!referenced[refId]) referenced[refId] = []
              referenced[refId].push(article.id)
            })
          })

          // Add new tab
          this.graphs.push({
            source: source,
            input: inputArticles,
            suggested: [],
            referenced: referenced,
            tabLabel: label || source.authors[0].LN + ' ' + source.year,
            tabTitle: title || source.title,
            API: (this.useMA) ? 'Microsoft Academic' : 'Crossref',
            timestamp: Date.now()
          })

          // Don't keep more articles in tab-bar than maxTabs
          if (this.graphs.length > this.maxTabs) this.graphs = this.graphs.slice(1)

          // Let user explore input articles while suggested articles are still loading
          this.currentGraphIndex = this.graphs.length - 1
          this.isLoading = false

          /* Find suggested articles */
          // sort articles by number of local citations (InDegree) and pick max top 10
          // https://medium.com/@alleto.saburido/set-theory-for-arrays-in-es6-eb2f20a61848
          const suggestedIds = Object.keys(referenced)
          // Only suggest articles that have at least two local citations and that aren't already among input articles
          // Careful with comparing DOIs!!! They have to be all upper case (performed by crossrefResponseToArticleArray & microsoftAcademicResponseToArticleArray)
            .filter(x => referenced[x].length > 1 && !inputArticlesIds.includes(Number(x) || x)) // If x is numeric (i.e. Id from Microsoft Academic), convert to Number, otherwise keep DOIs from Crossref
            .sort((a, b) => referenced[b].length - referenced[a].length).slice(0, 10)

          // In case no suggested ids are found
          if (!suggestedIds.length) {
            this.saveState()
            return false
          }

          this.callAPI(suggestedIds, response => {
            // Careful: Array/object item setting can't be picked up by Vue (https://vuejs.org/v2/guide/list.html#Caveats)
            this.$set(this.graphs[this.graphs.length - 1], 'suggested', this.responseToArray(response.data))
            this.init()
            this.saveState()
          }, suggestedIds.length)
        }, source.references.length)
      } catch (e) {
        this.errorMessage(e)
      }
    },
    clickOpenReferences: function (article) {
      const id = article.id
      const graphIds = this.graphs.map(graph => graph.source.id)

      // If reference is already open in a different tab: change tabs only
      if (graphIds.includes(id)) {
        this.currentGraphIndex = graphIds.indexOf(id)
      // Don't load new source through API because data is already in current input (only when source used same API as currently active)
      } else if ((typeof id === 'number') === this.useMA) {
        const source = this.currentGraph.input.filter(x => x.id === id)[0] ||
                       this.currentGraph.suggested.filter(x => x.id === id)[0]
        this.isLoading = true
        this.setNewSource(source)
      // Load new source through API when source used different API than currently active
      } else {
        this.newSourceDOI = String(article.doi)
      }
    },
    clickButtonAdd: function () {
      this.$buefy.dialog.prompt({
        message: 'Enter DOI of new source article',
        inputAttrs: {
          placeholder: 'e.g. 10.1126/SCIENCE.AAC4716',
          maxlength: 50
        },
        onConfirm: value => { this.newSourceDOI = value }
      })
    },
    clickCloseTab: function (index) {
      // Close tab
      this.graphs.splice(index, 1)
      // If a tab is closed before the selected one or the last tab is selected and closed: update currentGraphIndex
      if (this.currentGraphIndex > index || this.currentGraphIndex > this.graphs.length - 1) {
        this.currentGraphIndex--
        if (this.currentGraphIndex === -1) this.currentGraphIndex = undefined
      }
      this.saveState()
    },
    clickCloseAllTabs: function () {
      this.$buefy.dialog.confirm({
        message: 'Do you want to close all reference tabs?',
        type: 'is-danger',
        confirmText: 'Close All',
        onConfirm: () => {
          this.currentGraphIndex = undefined
          this.graphs = []
          this.saveState()
        }
      })
    },
    highlightNodes: function (selectedNodes = undefined) {
      const network = (this.showAuthorNetwork) ? authorNetwork : referenceNetwork

      // When nodes are clicked in authorNetwork, the selectedNodes are supplied by argument, otherwise they depend on table selection and are figured out here
      if (!selectedNodes) {
      // Highlight selected node if one is selected
        if (this.showAuthorNetwork) {
          selectedNodes = []
          this.selected.authors.map(x => x.FN + ' ' + x.LN).forEach(author => {
            if (network.body.data.nodes.getIds().includes(author)) {
              selectedNodes.push(author)
            }
          })
        } else {
          if (network.body.data.nodes.getIds().includes(this.selected.id)) {
            selectedNodes = [this.selected.id]
          }
        }
      }

      network.selectNodes(selectedNodes)
      const connectedNodes = network.getConnectedNodes(selectedNodes)

      // Code loosely adapted from: https://github.com/visjs/vis-network/blob/master/examples/network/exampleApplications/neighbourhoodHighlight.html
      const updatedNodes = network.body.data.nodes.get().map(function (node) {
        node.color = (selectedNodes.includes(node.id) || connectedNodes.includes(node.id)) ? undefined : 'rgba(200,200,200,0.3)'
        if (selectedNodes.includes(node.id)) {
          if (node.hiddenLabel !== undefined) {
            node.label = node.hiddenLabel
            node.hiddenLabel = undefined
          }
        } else {
          if (node.hiddenLabel === undefined) {
            node.hiddenLabel = node.label
            node.label = undefined
          }
        }
        return node
      })

      network.body.data.nodes.update(updatedNodes)
    },
    init: function () {
      // Sort input & suggested articles by InDegree (descending)
      this.currentGraph.input.sort(this.sortInDegree)
      this.currentGraph.suggested.sort(this.sortInDegree)

      // Select top article for both tables
      this.selectedInputArticle = this.currentGraph.input[0]
      this.selectedSuggestedArticle = this.currentGraph.suggested[0]

      // Networks are handled by vis.js outside of Vue through these two global init function
      // Initializing both networks now incurs higher CPU usage now but then tab changes are quicker compared to init at watcher:showAuthorNetwork (especially when going back and forth)
      initAuthorNetwork(this)
      initReferenceNetwork(this)
      // Sometimes this call to highlightNodes() leads to two calls in short frequency (because watch:selected will often be called right afterwards) but this call is still necessary (apparently mostly when loading new graphs)
      this.highlightNodes()
    },
    // compareFunction for array.sort(), in this case descending by default (https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/sort)
    sortInDegree: function (a, b) {
      a = (this.currentGraph.referenced[a.id]) ? this.currentGraph.referenced[a.id].length : 0
      b = (this.currentGraph.referenced[b.id]) ? this.currentGraph.referenced[b.id].length : 0
      return b - a
    },
    // Wrapper for Buefy tables with third argument "ascending"
    sortInDegreeWrapper: function (a, b, ascending) {
      return (ascending) ? this.sortInDegree(b, a) : this.sortInDegree(a, b)
    },
    callAPI: function (ids, response, count) {
      if (this.useMA) {
        // For Microsoft Academic the user inputs DOIs but the API returns references as proprietory numeric Ids
        if (String(ids[0]).match(/10\.\d{4,9}\/.+/)) {
          return microsoftAcademicEvaluate('Or(DOI=\'' + ids.join('\',DOI=\'') + '\')', response, count, this.customKeyMA)
        } else {
          return microsoftAcademicEvaluate('Or(Id=' + ids.join(',Id=') + ')', response, count, this.customKeyMA)
        }
      } else {
        // In Crossref the API also returns references as DOIs
        return crossrefWorks('doi:' + ids.join(',doi:'), response, count)
      }
    },
    responseToArray: function (data, sourceReferences = false) {
      if (this.useMA) {
        return microsoftAcademicResponseToArticleArray(data, sourceReferences)
      } else {
        return crossrefResponseToArticleArray(data, sourceReferences)
      }
    },
    errorMessage: function (e, title = 'Error') {
      this.isLoading = false
      this.$buefy.dialog.alert({
        title: title,
        message: String(e),
        type: 'is-danger'
      })

      // Reset input variables so that watchers fire again even if same input is given
      this.newSourceDOI = undefined
      this.file = undefined
    },
    saveState: function () {
      if (this.autosaveResults) {
        localStorage.graphs = JSON.stringify(this.graphs)
        localStorage.autosaveResults = true
        if (this.customKeyMA) localStorage.customKeyMA = this.customKeyMA
        else localStorage.removeItem('customKeyMA')
      } else {
        localStorage.clear()
      }
    },
    filterArticles: function (articles) {
      const re = new RegExp(this.filterString, 'gi')
      switch (this.filterColumn) {
        case 'titleAbstract':
          return articles.filter(article => String(article.numberInSourceReferences).match(new RegExp(this.filterString, 'y')) || article.title.match(re) || (article.abstract && article.abstract.match(re)))
        case 'authors':
          return articles.filter(article => article.authors.map(author => (author.FN + ' ' + author.LN)).join(', ').match(re))
        case 'year':
          return articles.filter(article => String(article.year).match(re))
        case 'journal':
          return articles.filter(article => String(article.journal).match(re))
        default:
          return articles
      }
    },
    authorString: function (authors) {
      return (authors && authors.length) ? authors.map(x => ((x.FN) ? (x.FN) + ' ' : '') + x.LN).join(', ') : ''
    },
    authorStringShort: function (authors) {
      return (authors && authors.length > 5) ? this.authorString(authors.slice(0, 5).concat({ LN: '(' + (authors.length - 5) + ' more)' })) : this.authorString(authors)
    },
    // Toggle autosave option
    clickToggleAutosave: function () {
      this.autosaveResults = !this.autosaveResults
      this.saveState()
      this.$buefy.toast.open({
        message: (this.autosaveResults) ? 'Local autosave on' : 'Local autosave off',
        type: (this.autosaveResults) ? 'is-success' : 'is-danger',
        queue: false
      })
    },
    clickToggleMA: function () {
      this.useMA = !this.useMA
      if (this.useMA) {
        this.$buefy.dialog.prompt({
          message: 'Use your own Microsoft Academic API key (<a href="https://msr-apis.portal.azure-api.net/products/project-academic-knowledge" target="_blank">create here for free</a>), which is faster and more reliable than the test key! Stays local and is only shared with Microsoft. Leave empty to keep using test key.',
          inputAttrs: {
            placeholder: 'Keep using test key',
            value: this.customKeyMA,
            maxlength: 100,
            required: false
          },
          trapFocus: true,
          confirmText: 'Use Microsoft Academic',
          onConfirm: value => {
            this.$buefy.toast.open({
              message: 'Using Microsoft Academic.',
              type: 'is-success',
              queue: false
            })
            this.customKeyMA = (value.trim()) ? value.trim() : undefined
          },
          cancelText: 'Use Crossref',
          onCancel: () => { this.useMA = false }
        })
      } else {
        this.$buefy.toast.open({
          message: 'Microsoft Academic API turned off. Using Crossref as fallback.',
          type: 'is-danger',
          queue: false
        })
      }
    },
    loadExamples: function () {
      this.isLoading = true
      const scriptTag = document.createElement('script')
      scriptTag.setAttribute('src', 'examples.js')
      document.getElementsByTagName('head')[0].appendChild(scriptTag)
    },
    toggleArticle: function () {
      // Make sure article can even be toggled (compare with :has-detailed-visible in b-table in index.html)
      if (this.selected.abstract || (this.currentGraph.source.citationContext && this.currentGraph.source.citationContext[this.selected.id])) {
        (this.showSuggested) ? this.$refs.suggestedArticlesTable.toggleDetails(this.selectedSuggestedArticle) : this.$refs.inputArticlesTable.toggleDetails(this.selectedInputArticle)
        if (document.getElementById(this.selected.id)) document.getElementById(this.selected.id).scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    },
    formatAbstract: function (abstract) {
      return abstract.replace(/Importance:? ?/, '<br><em>Importance:</em> ').replace(/Background:? ?/, '<br><em>Background:</em> ').replace(/Aims?:? ?/, '<br><em>Aims:</em> ').replace(/Goals?:? ?/, '<br><em>Goals:</em> ').replace(/Objectives?:? ?/, '<br><em>Objectives:</em> ').replace(/Main Outcomes? and Measures:? ?/, '<br><em>Main Outcomes and Measures:</em> ').replace(/Methods?:? ?/, '<br><em>Methods:</em> ').replace(/Results?:? ?/, '<br><em>Results:</em> ').replace(/Discussion:? ?/, '<br><em>Discussion:</em> ').replace(/Conclusions?:? ?/, '<br><em>Conclusions:</em> ').replace(/<br>/, '')
    },
    importList: function () {
      this.editListOfDOIs = false
      this.isLoading = true
      this.setNewSource({ references: this.listOfDOIs, referencesCountTotal: this.listOfDOIs.length }, this.listName, this.listName)
    }
  },
  created: function () {
    const urlParams = new URLSearchParams(window.location.search)

    try {
      if (localStorage.graphs) this.graphs = JSON.parse(localStorage.graphs)
      if (localStorage.autosaveResults) this.autosaveResults = localStorage.autosaveResults
      if (localStorage.customKeyMA) this.customKeyMA = localStorage.customKeyMA
    } catch (e) {
      localStorage.clear()
      console.log("Couldn't load cached networks")
    }

    // Open source DOI from link
    if (urlParams.has('sourceDOI')) {
      this.newSourceDOI = urlParams.get('sourceDOI')
      // Open list of DOIs from link if tab is not already stored in localStorage
    } else if (urlParams.has('listOfDOIs')) {
      let editList = urlParams.has('editList') ? urlParams.get('editList') : false
      const name = urlParams.has('name') ? urlParams.get('name') : 'Custom'
      // Safety measure to allow max. 500 DOIs (not sure if Microsoft Academic actually allows this, CrossRef definitely doesn't)
      const dois = urlParams.get('listOfDOIs').split(',').slice(0, 500)

      // If a custom list with the same name already exists, let user chose new name
      if (this.graphs.map(x => x.tabLabel).includes(name)) {
        editList = true
      }

      this.listOfDOIs = dois
      this.listName = name
      if (editList) {
        this.editListOfDOIs = true
      } else {
        this.importList()
      }
    }

    if (this.graphs.length) {
      this.currentGraphIndex = 0
    }
  }
})
