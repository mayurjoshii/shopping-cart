import React from 'react';
import ReactDOM from 'react-dom';
import { createStore, combineReducers } from 'redux';
import './index.css';

const todo = (state = {
    cash: 400,
    itemsLeft: 10,
} , action) => {
    switch(action.type){
        case 'MINUS':
            state.cash-= 10;
            return state;
        
        default:
            return state;
    }
}

const dairyProducts = (state = {
    dairyProducts: [{
        id: 0,
        name: 'Cheese',
        cost: 10
    },
    {
        id: 1,
        name: 'Milk',
        cost: 20
    }]
},action) => {
    switch(action.type){
        default:
            return state;
    }
}


const elecProducts = (state = {
    elecProducts: [{
        id: 0,
        name: 'Mobile Charger',
        cost: 200
    },{
        id: 1,
        name: 'Hair Dryer',
        cost: 100
    }]
},action) => {
    switch(action.type){
        default:
         return state;
    }
}

const combined = combineReducers({
    todo,
    dairyProducts,
    elecProducts
});

const store = createStore(combined);
//store.dispatch({ type: 'MINUS' });

//console.log(store.getState());


const DairyList = ({ dairyProducts }) => (
    <section>
        Dairy Products:
        <ul>
            {dairyProducts.map(item => (
                <li key={item.id}>{item.name}</li>
            ))}
        </ul>
    </section>
)

const ElecList = ({ elecProducts }) => (
    <section>
        Electronic Products:
        <ul>
            {elecProducts.map(item => (
                <li key={item.id}>{item.name}</li>
            ))}
        </ul>
    </section>
)


const App = ({ todo, dairyProducts, elecProducts}) => (
    <div>
        <DairyList {...dairyProducts} />
        <ElecList {...elecProducts} />
    </div>
)

const render = () => {
    ReactDOM.render(<App {...store.getState()} />, document.getElementById('root'));
}

store.subscribe(render);
render();
