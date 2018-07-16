# BULGAKOV  
  
**BULGAKOV** является микросервисом обмена данными между фронтендом и микросервисами [golos.io](https://golos.io).  
Также известен как фронтенд-гейт. Использует веб-сокеты с JSON-RPC для общения с клиентами.
Дополнительно осуществляет авторизацию пользователей.

### Основное

Микросервис пробрасывает данные между клиентами и микросервисами, используя роутинг по трем поинтам:

  - Идентификатор канала - определяется на этапе подключения пользователя.  
   Гарантирует что данные поступят конкретному получателю.
  - Имя пользователя - идентификатор пользователя, определяется автоматически.   
   Гарантирует что пользователю будут доступны только предназначенные ему данные.
  - Идентификатор запроса - определяется идентификатором JSON-RPC.    
   Гарантирует порядок и идентификацию ответов.  
   При этом на 1 запрос может быть множество ответов с одинаковым идентификатором (например для подписки на что-либо).

Данные внутри формируются в особом формате и переправляются дальше:

 ```
 {
    _frontendGate: true, // флаг формата фронтенд-гейта
    channelId: <id>,     // канал
    requestId: <id>,     // запрос
    user: <name>,        // имя пользователя
    params: <data>,      // оригинальные данные
 }
 ```

Пользователь обратно получает данные в обычном JSON-RPC формате - это может быть как ответ целевого сервиса, 
так и ответ с ошибкой на уровне гейта, в случае возникновения оной.

### Роутинг запросов клиента

Метод JSON-RPC необходимо формировать из двух частей - имени целевого микросервиса и метода, который необходим.
Например указав `notify.subscribe` можно обратится к сервису нотификаций с JSON-RPC методом subscribe.

### Авторизация

При подключении сервер оповещает о необходимости авторизироваться.
Запрос содержит поле параметров, первым элементом является секретная строка, которую нужно подписать приватным
ключем, оформив объект в виде фейковой транзакции в виде:

 ```
 {
     ref_block_num: 3367,
     ref_block_prefix: 879276768,
     expiration: '2018-07-06T14:52:24',
     operations: [
         [
             'vote',
             {
                 voter: <user>,      // Имя пользователя
                 author: 'test',
                 permlink: <secret>, // Секрет, который пришел в запросе с сервера
                 weight: 1,
             },
         ],
     ],
     extensions: [],
 }
 ```

Для подписи можно использовать возможности библиотеки golos-js и осуществить подпись
вызовом `golos.auth.signTransaction(<fake>, [<private_key>])`.

В ответ необходимо отправить запрос с произвольным не пустым JSON-RPC методом и двумя параметрами - `user` и `sign`.
Первый должен содержать имя пользователя, а второй - сгенерированную подпись.  
В случае успеха текущее подключение будет закреплено за указанным пользователем.

*При этом приватный ключ не передается по сети, обеспечивая безопасность авторизации.*
 
### Переменные окружения

Возможные переменные окружения `ENV`:

  - `FRONTEND_GATE_LISTEN_PORT` *(обязательно)* - адрес порта, который будет использован для входящих веб-сокет подключений клиентов.    
   Дефолтное значение - `8080`, пересекается с `GATE_LISTEN_PORT` .
   
  - `GATE_LISTEN_PORT` *(обязательно)* - адрес порта, который будет использован для входящих подключений связи микросервисов.    
   Дефолтное значение - `8080`, пересекается с `FRONTEND_GATE_LISTEN_PORT`    

  - `DAY_START` - время начала нового дня в часах относительно UTC.    
   Дефолтное значение - `3` (день начинается в 00:00 по Москве). 
     
  - `METRICS_HOST` - адрес хоста для метрик StatsD.  
   Дефолтное значение - `localhost` 
    
  - `METRICS_PORT` - адрес порта для метрик StatsD.  
   Дефолтное значение - `8125` 
 
  - `SOLZHENITSYN_CONNECT_STRING` - адрес подключения к микросервису настроек.
  
  - `NOTIFY_CONNECT_STRING` - адрес подключения к микросервису нотификаций.   
