// Microsoft Academic Evaluate output

function ma_evaluate_expr_from_ids(ids) {
	return "Or(Id=" + ids.join(",Id=") + ")"
}

//https://msr-apis.portal.azure-api.net/docs/services/academic-search-api/operations/565d9001ca73072048922d97
//https://docs.microsoft.com/en-us/azure/cognitive-services/academic-knowledge/entityattributes
function microsoft_academic_evaluate(expression, response, count=1, attributes=["Id","E","Y","ECC","RId"], offset=0, model="latest", orderby="", api_key="") {
	var body = {
        'expr': expression,
        'model': model,
        'count': count,
        'offset': offset,
        'orderby': orderby,
        'attributes': attributes.join(",")
    }

    // Encode request body as URLencoded
    //https://stackoverflow.com/questions/22678346/convert-javascript-object-to-url-parameters
    body = Object.keys(body).map(function(k) {
    	return encodeURIComponent(k) + "=" + encodeURIComponent(body[k]);
	}).join('&')

    return axios.post("https://api.labs.cognitive.microsoft.com/academic/v1.0/evaluate", body, config={
		headers: { "Content-Type": 'application/x-www-form-urlencoded', 'Ocp-Apim-Subscription-Key': api_key }
	}).then(response).catch(function (error, response) {
    	console.log('Error! Could not reach the Microsoft Academic API. ' + error)
	})
}

/* vis.js Reference graph */

// I've tried keeping referenceNetwork in Vue.data, but it slowed things down a lot -- better keep them as globals as network is not rendered through Vue anyway
var referenceNetwork;

function initReferenceNetwork(app) {
	var node_ids = app.inputArticlesIds.concat(app.suggestedArticlesIds)

	// create an array with edges
	var inDegree = {}
	var outDegree = {}
	var edges = app.inputArticles.map(article => {
		return (!article.RId) ? [] : article.RId.map(ref => {
			if (node_ids.includes(ref)) {
				inDegree[ref] = (inDegree[ref]) ? inDegree[ref] + 1 : 1
				outDegree[article.Id] = (outDegree[article.Id]) ? outDegree[article.Id] + 1 : 1
				
				return {from: article.Id, to: ref}
			}
			else {
				return []
			}
		})
	}).flat(2);
	
	// create an array with nodes only for nodes with in- / out-degree >= 1 (no singletons)
	var nodes = app.inputArticles.concat(app.suggestedArticles).map(article => { return (!inDegree[article.Id] & !outDegree[article.Id]) ? [] : {
		id: article.Id,
		title: article.ANF[0].LN + ", " + article.Y,
		level: article.Y,
		group: article.Y,
		size: (((inDegree[article.Id]) ? inDegree[article.Id] : 0) + 2)*10,
		shape: (app.inputArticlesIds.includes(article.Id)) ? "dot" : "star",
		label: article.ANF[0].LN + ",\n" + article.Y
	}}).flat();
	
	// create a network
	var options = {
		layout: {
			hierarchical: {
				direction: "DU"
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
			},
		},
		physics: {
			hierarchicalRepulsion: {
				nodeDistance: 350
			}
		},
		configure: false
	};
	referenceNetwork = new vis.Network(document.getElementById("referenceNetwork"), { nodes: nodes, edges: edges }, options);
	referenceNetwork.on("click", networkOnClick);

	function networkOnClick(params) {
		// Select corresponding row in table
		if (params.nodes.length > 0) {
			selectedNode = params.nodes[0]
			// Input article node was clicked (circle)
			if (app.inputArticlesIds.includes(selectedNode)) {
				app.showSuggested = 0
				app.selectedInputArticle = app.inputArticles[app.inputArticlesIds.indexOf(selectedNode)]
			// Suggested article node was clicked (star)
			} else {
				app.showSuggested = 1
				app.selectedSuggestedArticle = app.suggestedArticles[app.suggestedArticlesIds.indexOf(selectedNode)]
			}
		}
	}
}

/* App logic */

Vue.use(Buefy)

var app = new Vue({ 
    el: '#app',
    data: {
    	graphs: [],
    	newQuery: undefined,
    	inputIds: undefined,

    	// Tables
    	selectedInputArticle: undefined,
        selectedSuggestedArticle: undefined,
        
        // UI
        currentGraphIndex: undefined,
        showSuggested: 0,
        isLoading: false
    },
    computed: {
    	currentGraph: function() {
    		if (this.currentGraphIndex === undefined | this.graphs.length === 0) return {}
    		return this.graphs[this.currentGraphIndex]
    	},
    	inputArticles: function() {
    		return this.articlesTableArray(this.currentGraph.inputMA)
    	},
		inputArticlesIds: function() {
			return this.inputArticles.map(article => article.Id)
		},
		referenced: function() {
			// Can't use inputArticles here because articlesTableArray() uses referenced
			var referenced = {}
    		this.currentGraph.inputMA.entities.forEach(article => {
				if (!article.RId) return;
				article.RId.forEach(refId => {
					if (!referenced[refId]) referenced[refId] = []
					referenced[refId].push(article.Id)
				})
			})
			return referenced
		},
		suggestedArticles: function() {
    		return this.articlesTableArray(this.currentGraph.suggestedMA)
    	},
		suggestedArticlesIds: function() {
			return this.suggestedArticles.map(article => article.Id)
		},
    	selected: function() {
    		return this.showSuggested ? this.selectedSuggestedArticle : this.selectedInputArticle
    	}
    },
    watch: {
    	currentGraph: function() {
    		// During loading of new graphs currentGraph changes multiple times (updates with new sourceMA, inputMA and suggestedMA each) -> don't init
    		if (!this.isLoading) {
				this.init()
    		}
    	},
    	newQuery: function() {
    		this.isLoading = true
			var id = Number(this.newQuery)
			if (id != NaN) {
				microsoft_academic_evaluate(ma_evaluate_expr_from_ids([id]), this.newSource, count=1)
			}
			// TODO curstom source list
			else {

			}
    	},
    	inputIds: function() {
    		microsoft_academic_evaluate(
				ma_evaluate_expr_from_ids(this.inputIds),
				response => {
					// Careful: Array/object item setting can't be picked up by Vue (https://vuejs.org/v2/guide/list.html#Caveats)
					this.$set(this.graphs[this.graphs.length-1], "inputMA", response.data)
					// Update currentGraphIndex before calling findSuggestions() so that this.referenced will be calculated for new article
					this.currentGraphIndex = this.graphs.length-1
					this.findSuggestions()
				},
				count=this.inputIds.length
			)
    	},
    	// Selection in left column table leads to different action depending on which right column tab is active
    	selected: function() {
    		if (!this.selected) return false
    		
    		// Highlight the right network node
    		this.highlightNode()
    		
    		// Scroll to right row
			if (document.getElementById(this.selected.Id)) document.getElementById(this.selected.Id).scrollIntoView({ behavior: "smooth", block: "center" })
    	},
    },
    methods: {
		newSource: function(response) {
			try {
				// Some papers are in MA but don't have references themselves
				if (!response.data.entities[0].RId) throw "No references found"
				this.inputIds = response.data.entities[0].RId
				// Not sure why this line is unnecessary in inputIds > microsoft_academic_evaluate > response =>
				if (typeof response.data.entities[0].E === "string") response.data.entities[0].E = JSON.parse(response.data.entities[0].E)
				this.graphs.push({
					label: response.data.entities[0].E.ANF[0].LN + ", " + response.data.entities[0].Y,
					title: response.data.entities[0].E.DN,
					sourceMA: response.data
				})
			} catch(e) {
				this.isLoading = false
				this.$buefy.dialog.alert({
					title: "Error",
					message: "No references found in Microsoft Academic API for paper with Id: " + app.newSourceId,
					type: "is-danger"
				})
			}
		},
    	clickOpenReferences: function(Id) {
    		var graphIds = this.graphs.map(graph=>graph.sourceMA.entities[0].Id)
			// If reference is already open in a different tab: change tabs only
			if (graphIds.includes(Id)) {
    			this.currentGraphIndex = graphIds.indexOf(Id)
    		} else {
    			// Don't load sourceMA through API because data is already in current inputMA
    			var sourceMA = {expr: ma_evaluate_expr_from_ids([Id]), entities: this.currentGraph.inputMA.entities.filter(x => x.Id==Id)}
				if (!sourceMA.entities[0].RId) throw "No references found" // shouldn't occur because button should be disabled
				this.isLoading = true
				this.inputIds = sourceMA.entities[0].RId
				this.graphs.push({ sourceMA: sourceMA })
    		}
    	},
    	clickButtonAdd: function() {
    		this.$buefy.dialog.prompt({
                    message: "Enter Microsoft Academic ID of new source article",
                    inputAttrs: {
                        placeholder: "e.g. 2905137810",
                        maxlength: 15
                    },
                    onConfirm: (value) => this.newQuery = value
                })
    	},
    	clickCloseTab: function(index) {
    		// Close tab
    		this.graphs.splice(index,1)
			// If a tab is closed before the selected one or the last tab is selected and closed: update currentGraphIndex
    		if (this.currentGraphIndex > index | this.currentGraphIndex > this.graphs.length-1) {
    			this.currentGraphIndex--
    		}
    	},
    	articlesTableArray: function(ma, attr=["Id","DN","DOI","ANF","Y","BV","ECC","RId"]) {
    		if (!ma) return []
			if (!Object.keys(ma).length) return []
			
			// https://stackoverflow.com/posts/32184094/revisions
			return ma.entities.map((article, index) => {
				if (article["E"]) if (typeof article["E"] === "string") article["E"] = JSON.parse(article["E"])
				
				article = attr.reduce((acc, cur) => {
					acc[cur] = (article[cur] ? article[cur] : (article["E"]) ? article["E"][cur] : undefined); return acc;
				}, {}) // add e.g. 'index: index' inside {} as initialValue, see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/reduce
		
				article.numRefs = (article.RId) ? article.RId.length : 0
				article.inDegree = (this.referenced[article.Id]) ? this.referenced[article.Id].length : 0
				
				return article
			})
		},
    	findSuggestions: function() {
    		// Suggest articles: sort articles that aren't already among input articles by number of references and pick top 10
			// https://medium.com/@alvaro.saburido/set-theory-for-arrays-in-es6-eb2f20a61848
			var suggested_ids = Object.keys(this.referenced)
				.map(x => Number(x))
				.filter(x => !this.inputArticlesIds.includes(x))
				.sort((a, b) => this.referenced[b].length-this.referenced[a].length).slice(0,10)
			microsoft_academic_evaluate(
				ma_evaluate_expr_from_ids(suggested_ids),
				response => {
					// Careful: Array/object item setting can't be picked up by Vue (https://vuejs.org/v2/guide/list.html#Caveats)
					this.$set(this.graphs[this.graphs.length-1], "suggestedMA", response.data)
					localStorage.graphs = JSON.stringify(this.graphs)
					this.isLoading = false
					this.init()
				},
				count=app.inputArticlesIds.length
			)
    	},
    	highlightNode: function() {
    		var selectedNode, connectedNodes = [], updatedNodes
    		
			// Highlight selected node if one is selected
    		if (referenceNetwork.body.data.nodes.getIds().includes(this.selected.Id)) {
    			selectedNode = [this.selected.Id]
    			connectedNodes = referenceNetwork.getConnectedNodes(selectedNode)
    			referenceNetwork.selectNodes(selectedNode)
    		} else {
    			referenceNetwork.selectNodes([])
    		}

    		// Code loosely adapted from: https://github.com/visjs/vis-network/blob/master/examples/network/exampleApplications/neighbourhoodHighlight.html
    		updatedNodes = referenceNetwork.body.data.nodes.get().map(node => {
    			node.color = (selectedNode.includes(node.id) | connectedNodes.includes(node.id)) ? undefined : 'rgba(200,200,200,0.3)';
				if (selectedNode.includes(node.id)) {
					if (node.hiddenLabel !== undefined) {
						node.label = node.hiddenLabel;
						node.hiddenLabel = undefined;
					}
				} else {
					if (node.hiddenLabel === undefined) {
						node.hiddenLabel = node.label;
						node.label = undefined;
					}
				}
				return node
			})

			referenceNetwork.body.data.nodes.update(updatedNodes);
    	},
    	init: function() {
    		console.log("init")
    		this.selectedInputArticle = this.inputArticles.sort((a, b) => ((this.referenced[b.Id]) ? this.referenced[b.Id].length : 0) - ((this.referenced[a.Id]) ? this.referenced[a.Id].length : 0))[0]
    		this.selectedSuggestedArticle = this.suggestedArticles.sort((a, b) => ((this.referenced[b.Id]) ? this.referenced[b.Id].length : 0) - ((this.referenced[a.Id]) ? this.referenced[a.Id].length : 0))[0]
    		initReferenceNetwork(this)
    	}
    },
    mounted: function() {
    	try {
    		if (localStorage.graphs) this.graphs = JSON.parse(localStorage.graphs)
    	} catch(e) {
    		localStorage.removeItem("graphs")
    		console.log("Couldn't load cached graphs")
    	}
    	if (this.graphs.length) {
    		this.currentGraphIndex = 0
    	}
    }
});