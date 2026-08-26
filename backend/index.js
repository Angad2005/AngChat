const express=require('express');
const cors=require('cors');
const path = require('path');
const app=express();

app.use(express.json());
app.use(cors());

// app.get('/',(req,res)=>{
//     res.send('Hello from backend');
// })
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..' , 'public', 'First.html'));
});

app.listen(3000,()=>{
    console.log('Server is running on port 3000');
    console.log("🚀 Visit: http://localhost:3000");
})