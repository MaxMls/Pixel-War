process.title = 'Pixel Wat Server'
const
	sqlite3 = require('sqlite3').verbose()
	fs = require('fs'),
	http = require('http'),
	PNG = require('pngjs').PNG,
	webSocketServer = require('websocket').server
	request = require("request")

// static функции
const 
	isU = (p) => typeof p === 'undefined' // p обязательно должна быть объявлена
	inRange = (num, a, b) => a <= num && num <= b
	intToRGB = (colorInt) => {return { r: colorInt >> 16 & 255, g: colorInt >> 8 & 255, b: colorInt & 255 }}
	RGBToInt = (color) => color.r << 16 | color.g << 8 | color.b
	posToInt = (width, x, y) => x + y * width
	intToPos = (width, int) => {return {x:int % width, y: (int / width)>>0}}
	htmlEntities = (str) => String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
	getUser = (id, callback) => request({method: 'GET', url: 'https://api.vk.com/method/users.get', qs: {user_ids: id, access_token: '179df5a1179df5a1179df5a1a017c2b5ea1179d179df5a14e6446fde7cc57496054bbe2', v: '5.92'}}, (error, response, body) => callback(body))




// http server
var pages = {
	'/': 'index.html',
	'/adminka': 'admin.html'
}

for (let i in pages){
	pages[i] =    fs.readFileSync(pages[i], 'utf8')
}

const
	content = fs.readFileSync('index.html', 'utf8'),
	serverPort = process.env.PORT | 8080,
	server = http.createServer((request, response) => {
		let path = request.url.split('?')[0];

		if (path in pages){
			response.writeHead(200, { "Content-Type": "text/html; charset=UTF-8" })
			response.write(pages[path])
		}
		else{
			response.writeHead(404, { "Content-Type": "text/plain; charset=UTF-8" })
			response.write('404. Страница не найдена')
		}
		response.end()
	})
server.listen(serverPort, function() { console.log("%s Server is listening on port %d", new Date(), serverPort)})
//


// работа с холстом
var rtHolst // холст с которым идет работа в реальном времени
const
	SetPixel = (holst, x, y, color) => {
		var idx = (holst.width * y + x) << 2
		holst.data[idx] = color.r
		holst.data[idx+1] = color.g
		holst.data[idx+2] = color.b
		holst.data[idx + 3] = 0xff
	},
	getBase64Holst = (holst) => PNG.sync.write(holst, {colorType:2}).toString('base64'),
	getHolst = (time, callback) => { // Получить состояние холста в определенном промежутке времени
		let holst = new PNG({width:300, height:168, colorType:2})
		db.each("SELECT pos, color FROM history WHERE date IN (SELECT MAX(date) FROM history WHERE date < ? GROUP BY pos)", time-0, (err, row) => {
			let pos = intToPos(holst.width, row.pos)
			let idx = (holst.width * pos.y + pos.x) << 2
			let col = intToRGB(row.color)

			holst.data[idx] = col.r
			holst.data[idx + 1] = col.g
			holst.data[idx + 2] = col.b
			holst.data[idx + 3] = 0xff
		}, (err, count) => {
			if(err) console.log(err)
			else callback(holst)
		})
	},
	SavePixel = (x, y, color, id) =>{
		SetPixel(rtHolst, x, y, intToRGB(color))
		db.run("INSERT INTO history (pos, color, user, date) VALUES (?, ?, ?, ?)", posToInt(rtHolst.width, x, y), color, id, Date.now())

	}
//

// Настройка бд
const db = new sqlite3.Database('pixels.sqlite3')
db.serialize( () => {
	// инфо по каждой точке
	db.run("CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY, pos INTEGER NOT NULL, color INTEGER NOT NULL, user INTEGER NOT NULL, date INTEGER NOT NULL)")
	// инфо о пользователях
	db.run("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, mid TEXT NOT NULL UNIQUE, name TEXT NOT NULL, lastPoint INTEGER NOT NULL)")

	getHolst(new Date(), (holst) => rtHolst = holst) // из базы получается последняя версия холста при запуске
})




// webSocket server
const 
	wsServer = new webSocketServer({httpServer: server}),
	clients = []
	clientsId = [] // не должны повторятся

wsServer.on('request', function(request) { // эта функция хранится до отключения юзера
	const client = {} // Данные о текущем пользователе
	client.authTime = new Date()
	client.lastPoint
	client.auth = false
	client.pointTimeout = 1000

	const connection = request.accept(null, request.origin)
	client.connection = connection
	client.ip = connection.remoteAddress

	console.log('%s Connection accepted %s', client.authTime, client.ip)
	


	connection.on('message', function(message) {
		if (message.type !== 'utf8') return

		const date = new Date()

		var json
		try {json = JSON.parse(message.utf8Data)} catch(e) {
			console.warn("%s Message Parse Error %s", date, client.ip)
			console.warn(message.utf8Data)
			return
		}
		if (isU(json.type)) {
			console.warn("%s Message Type Error %s", date, client.ip)
			console.warn(json)
			return
		}

		if (json.type === 'auth') {
			if (isU(json.session) || isU(json.session.mid) || !inRange(json.session.mid.length, 1, 50)){
				console.warn("%s Auth Data Error %s", date, client.ip)
				console.warn(json)
				return
			}
			const mid = json.session.mid

			const idIndex = clientsId.indexOf(mid)

			if(idIndex !== -1){ // Найти и закрыть прошлую сессию
				clientsId.splice(idIndex, 1)
				for (let i = clients.length - 1; i >= 0; i--) {
					if (clients[i].mid === mid){
						clients[i].connection.sendUTF(JSON.stringify({type: "debug", data: 'showPopup("Вы были отключены от сервера т.к запустили несколько сессий одновременно, вернитесь к новому окну или перезагрузите страницу для переподключения")'}))
						clients[i].connection.close()
					}
				}
			}

			

			getUser(mid, function(body) {
				let user
				try {user = JSON.parse(body)} catch(e) {
					console.warn('%s User Parse Error %s %s', date, mid, client.ip)
					console.warn(body)
					return
				}
				if(isU(user.response) || isU(user.response[0]) || isU(user.response[0].last_name) || isU(user.response[0].first_name)) {
					console.warn('%s User Get Error %s %s', date, mid, client.ip)
					console.warn(user)
					return
				}

				client.name = user.response[0].last_name + ' ' + user.response[0].first_name
				console.log('%s Connected %s %s %s', date, mid, client.name, client.ip)

				function setIsAuth() {
					client.auth = true
					client.mid = mid // уникальный идентификатор

					if (mid === "249533786") client.pointTimeout = 0 // подрубаем читы
					
					clients.push(client)
					clientsId.push(mid)
					
					connection.sendUTF(JSON.stringify({ type: "img", timeout: client.pointTimeout, data: getBase64Holst(rtHolst)})) //Отправить холст
				}

				// Добавить в базу, если нет и поменять имя если оно изменилось
				db.get("SELECT id, name, lastPoint FROM users WHERE mid = ?", mid, (e, r) => {
					if(!isU(r)){
						if (r.name !== client.name) {db.run("UPDATE users (name) VALUES (?) WHERE id = ?", client.name, r.id, setIsAuth)}
						else setIsAuth()
						client.id = r.id
						client.lastPoint = new Date(r.lastPoint)
					}
					else
						db.run("INSERT INTO users (mid, name, lastPoint) VALUES (?, ?, ?) ", mid, client.name, (new Date(0))-0, function (er) {
							client.id = this.lastID
							setIsAuth()
							client.lastPoint = new Date(0)
						})
				})
			})
		}
		else if (json.type === 'pixel') {
			let color = parseInt(json.color), x = parseInt(json.x), y = parseInt(json.y)
			if (isNaN(x) || isNaN(y)  || isNaN(color) || !inRange(x, 0, rtHolst.width-1) || !inRange(y, 0, rtHolst.height-1) || !inRange(color, 0, 16777216) || date - client.lastPoint < client.pointTimeout || !client.auth) {
				//Если пользователь пытается пройти незамеченным, закрыть соединение
				connection.sendUTF(JSON.stringify({type: "debug", data: 'let d = document.createElement(\'div\');d.innerHTML = \'<div style="position: fixed; top: 0;width: 100%"> <video style="margin:auto;display: block;" id="debugVideo" controls="controls" autoplay="autoplay" width="560" height="420" src="//lurkmore.so/images/video/rickroll.ogv" tabindex="0" style="background-image: url(&quot;http://www.gifbin.com/bin/042009/1241026091_youve_been_rickrolled.gif&quot;); background-repeat: no-repeat; background-position: center bottom;"><embed type="application/x-shockwave-flash" src="http://www.dailymotion.com/swf/video/x5l8e6?width=560&amp;theme=default&amp;foreground=%23F7FFFD&amp;highlight=%23FFC300&amp;background=%23171D1B&amp;additionalInfos=1&amp;autoPlay=1&amp;start=&amp;animatedTitle=&amp;hideInfos=0" width="560" height="420" allowfullscreen="true" allowscriptaccess="none" style="background-image: url(&quot;http://www.gifbin.com/bin/042009/1241026091_youve_been_rickrolled.gif&quot;); background-repeat: no-repeat; background-position: center bottom;"></video></div>\';document.body.appendChild(d);document.getElementById(\'debugVideo\').play()'}))
				connection.close()
				console.warn('%s Rickroll %s %s', date, client.mid, client.name)
				console.warn(json)
				return
			}
			client.lastPoint = date
			// Сохраняет пиксель и записывает в бд
			SavePixel(x, y, color, client.id)

			console.log('%s Pixel %s %s x:%d y:%d', date, client.mid, client.name, x, y)

			//Отправляет остальным клиентам
			let sendData = JSON.stringify({type: "pixel", y: y, x: x, color: color})
			for (let i = clients.length - 1; i >= 0; i--) {
				if (clients[i] !== client) 
					clients[i].connection.sendUTF(sendData)
				else
					clients[i].connection.sendUTF(JSON.stringify({type: "sync"}))
			}

		}
		
	})
	connection.on('close', function(connection) {
		let clientIndex = clients.indexOf(client)
		if (clientIndex !== -1){
			db.run("UPDATE users SET lastPoint = ? WHERE id = ?", client.lastPoint, client.id)
			clients.splice(clientIndex, 1)
			clientsId.splice(clientsId.indexOf(client.mid), 1)
			console.log('%s Disconnected %s %s', new Date(), client.mid, client.name)
		}
		else{
			console.log('%s Disconnected %s %s', new Date(), client.ip)
		}
	})
})